import { readFileSync } from "node:fs";
import vm from "node:vm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// public/sw.js is plain script: run it against a fake worker global and drive its event handlers.
// (This also covers the badge messages without the real Badge API, which crashes the headless test browser.)

const source = readFileSync("public/sw.js", "utf8");
const ORIGIN = "https://feed.test";

interface FakeEvent {
  request: { method: string; mode: string; url: string; destination: string };
  respondWith(p: Promise<Response> | Response): void;
  waitUntil(p: Promise<unknown>): void;
}

function boot(fetchImpl: (req: unknown, init?: { signal?: AbortSignal }) => Promise<Response>) {
  const listeners: Record<string, Array<(e: unknown) => void>> = {};
  const offline = new Response("<html><body>OFFLINE</body></html>", { status: 200, headers: { "content-type": "text/html" } });
  // Only the worker's own settings entries are kept (fetch caching stays out of these tests).
  const settings = new Map<string, Response>();
  const cache = {
    match: async (key: string) => (key === "/offline.html" ? offline.clone() : settings.get(String(key))?.clone()),
    keys: async () => [],
    put: async (key: string, res: Response) => {
      if (String(key).startsWith("/__feedferret/")) settings.set(String(key), res);
    },
    delete: async () => true,
    addAll: async () => {},
  };
  const badge = { setAppBadge: vi.fn(async () => {}), clearAppBadge: vi.fn(async () => {}) };
  const self = {
    location: { origin: ORIGIN },
    navigator: badge,
    addEventListener: (type: string, fn: (e: unknown) => void) => (listeners[type] ??= []).push(fn),
    clients: { claim: async () => {}, matchAll: async () => [], openWindow: async () => {} },
    skipWaiting: async () => {},
    registration: { showNotification: async () => {} },
  };
  const context = vm.createContext({
    self,
    caches: { open: async () => cache, keys: async () => [], match: async () => undefined, delete: async () => true },
    fetch: fetchImpl,
    Response,
    URL,
    Promise,
    AbortController,
    setTimeout,
    clearTimeout,
    Date,
    Map,
  });
  vm.runInContext(source, context);
  const dispatch = (type: string, event: unknown) => (listeners[type] ?? []).forEach((fn) => fn(event));
  /** A GET navigation; resolves to the response the worker chose, or `null` when it did not intercept. */
  const navigate = (path: string) => {
    let responded: Promise<Response> | null = null;
    const event: FakeEvent = {
      request: { method: "GET", mode: "navigate", url: ORIGIN + path, destination: "document" },
      respondWith: (p) => (responded = Promise.resolve(p)),
      waitUntil: () => {},
    };
    dispatch("fetch", event);
    return responded as Promise<Response> | null;
  };
  return { dispatch, navigate, badge };
}

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

const html = (text: string, init: ResponseInit = {}) => new Response(text, { status: 200, headers: { "content-type": "text/html" }, ...init });

describe("service worker navigations", () => {
  it("passes a fast answer through (HTTP errors too)", async () => {
    const sw = boot(async () => html("PAGE"));
    expect(await (await sw.navigate("/"))!.text()).toBe("PAGE");
    const sw500 = boot(async () => new Response("boom", { status: 500 }));
    expect((await sw500.navigate("/"))!.status).toBe(500);
  });

  it("a failed connection shows the offline page at once", async () => {
    const sw = boot(async () => {
      throw new TypeError("Failed to fetch");
    });
    const body = await (await sw.navigate("/"))!.text();
    expect(body).toContain("OFFLINE");
    expect(body).not.toContain('data-mode="slow"');
  });

  it("a hanging server is NOT abandoned at 3 s: the reader waits 8 s", async () => {
    let answer!: (r: Response) => void;
    const sw = boot(() => new Promise<Response>((resolve) => (answer = resolve)));
    const result = sw.navigate("/");
    let settled = false;
    void result!.then(() => (settled = true));
    await vi.advanceTimersByTimeAsync(7_900);
    expect(settled).toBe(false);
    answer(html("LATE PAGE"));
    expect(await (await result)!.text()).toBe("LATE PAGE");
  });

  it("after 8 s the offline page is offered in 'slow' mode and that request is aborted; 'keep waiting' is a brand-new request", async () => {
    const signals: Array<AbortSignal | undefined> = [];
    const answers: Array<(r: Response) => void> = [];
    const sw = boot((_req, init) => {
      signals.push(init?.signal);
      return new Promise<Response>((resolve) => answers.push(resolve));
    });
    const first = sw.navigate("/?v=later");
    await vi.advanceTimersByTimeAsync(8_000);
    expect(await (await first!).text()).toContain('<body data-mode="slow">');
    expect(signals).toHaveLength(1);
    expect(signals[0]?.aborted).toBe(true);
    answers[0](html("OLD ANSWER")); // arrives late: nobody is waiting for it
    await vi.advanceTimersByTimeAsync(10);
    // "Keep waiting" = reload of the same URL: a second, fresh request. The old answer is not reused.
    const second = sw.navigate("/?v=later");
    expect(signals).toHaveLength(2);
    answers[1](html("FRESH ANSWER"));
    expect(await (await second)!.text()).toBe("FRESH ANSWER");
  });

  it("a slow page of account A is never handed to account B (same URL, logout in between)", async () => {
    // Fake server: answers per signed-in account. A's request hangs, so the worker shows the slow page and gives up on it.
    let account = "A";
    const pendingA: Array<(r: Response) => void> = [];
    const sw = boot(() => {
      if (account === "A") return new Promise<Response>((resolve) => pendingA.push(resolve));
      return Promise.resolve(html("PAGE OF B"));
    });
    const aTab = sw.navigate("/article/1");
    await vi.advanceTimersByTimeAsync(8_000);
    const slow = await (await aTab!).text();
    expect(slow).toContain('data-mode="slow"');
    expect(slow).not.toContain("PAGE OF A");

    account = "B"; // A signs out, B signs in on the same device
    pendingA[0](html("PAGE OF A")); // A's server finally answers — too late
    await vi.advanceTimersByTimeAsync(10);

    const bTab = await sw.navigate("/article/1");
    const body = await bTab!.text();
    expect(body).toBe("PAGE OF B");
    expect(body).not.toContain("PAGE OF A");
    // And "keep waiting" from a still-open slow page of A (after B signed in) is a fresh request as B too.
    const reload = await sw.navigate("/article/1");
    expect(await reload!.text()).toBe("PAGE OF B");
  });

  it("a hanging request is aborted when the slow page is shown, and not before", async () => {
    let signal: AbortSignal | undefined;
    const sw = boot((_req, init) => {
      signal = init?.signal;
      return new Promise<Response>(() => {});
    });
    void sw.navigate("/");
    await vi.advanceTimersByTimeAsync(7_900);
    expect(signal?.aborted).toBe(false);
    await vi.advanceTimersByTimeAsync(200);
    expect(signal?.aborted).toBe(true);
  });

  it.each(["/login", "/register", "/setup", "/api/auth/callback/google", "/api/auth/signin"])("%s is never timed out", async (path) => {
    let answer!: (r: Response) => void;
    const sw = boot(() => new Promise<Response>((resolve) => (answer = resolve)));
    const result = sw.navigate(path);
    let settled = false;
    void result!.then(() => (settled = true));
    await vi.advanceTimersByTimeAsync(120_000); // far past every timeout
    expect(settled).toBe(false);
    answer(html("SLOW IDP"));
    expect(await (await result)!.text()).toBe("SLOW IDP");
  });

  it("sign-in pages still fall back to the offline page when the network is really down", async () => {
    const sw = boot(async () => {
      throw new TypeError("Failed to fetch");
    });
    expect(await (await sw.navigate("/login"))!.text()).toContain("OFFLINE");
  });

  it("never intercepts non-GET requests, cross-origin or /api data requests", () => {
    const sw = boot(async () => html("x"));
    let responded = false;
    const base = { respondWith: () => (responded = true), waitUntil: () => {} };
    sw.dispatch("fetch", { ...base, request: { method: "POST", mode: "navigate", url: ORIGIN + "/", destination: "" } });
    sw.dispatch("fetch", { ...base, request: { method: "GET", mode: "cors", url: "https://other.test/a.js", destination: "script" } });
    sw.dispatch("fetch", { ...base, request: { method: "GET", mode: "cors", url: ORIGIN + "/api/app/session", destination: "" } });
    expect(responded).toBe(false);
  });
});

describe("service worker badge (not shimmed)", () => {
  it("SET_BADGE with a count sets it, 0 / CLEAR_BADGE clears it", async () => {
    const sw = boot(async () => html("x"));
    const run = async (data: unknown) => {
      const waits: Array<Promise<unknown>> = [];
      sw.dispatch("message", { data, waitUntil: (p: Promise<unknown>) => waits.push(p) });
      await Promise.all(waits);
    };
    await run({ type: "SET_BADGE", count: 3 });
    expect(sw.badge.setAppBadge).toHaveBeenCalledWith(3);
    await run({ type: "SET_BADGE", count: 0 });
    await run({ type: "CLEAR_BADGE" });
    expect(sw.badge.clearAppBadge).toHaveBeenCalledTimes(2);
  });
});

describe("service worker badge preference (Settings → app badge, default on)", () => {
  it("push sets the badge by default; BADGE_PREF off clears it and keeps pushes from setting it; on again restores", async () => {
    const sw = boot(async () => html("x"));
    const run = async (type: string, data: unknown) => {
      const waits: Array<Promise<unknown>> = [];
      sw.dispatch(type, { data, waitUntil: (p: Promise<unknown>) => waits.push(p) });
      await Promise.all(waits);
    };
    const push = (count: number) => run("push", { json: () => ({ title: "t", unreadCount: count }) });

    await push(4);
    expect(sw.badge.setAppBadge).toHaveBeenLastCalledWith(4);

    await run("message", { type: "BADGE_PREF", enabled: false });
    expect(sw.badge.clearAppBadge).toHaveBeenCalledTimes(1);
    sw.badge.setAppBadge.mockClear();
    await push(5);
    expect(sw.badge.setAppBadge).not.toHaveBeenCalled();

    await run("message", { type: "BADGE_PREF", enabled: true });
    await push(6);
    expect(sw.badge.setAppBadge).toHaveBeenLastCalledWith(6);
  });
});
