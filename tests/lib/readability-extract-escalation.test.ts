// Escalation chain of fetchAndExtractReadable: escalates on BAD results (walls,
// teasers), not only on empty ones, and falls back between transports
// (browser-fingerprint impit ↔ plain undici) in both directions. Network is
// mocked; extraction is real.
import { beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({
  impit: null as null | (() => Promise<string>),
  plain: null as null | (() => Promise<string>),
  sidecar: null as null | string,
  calls: [] as string[],
  aiCalls: 0,
}));
vi.mock("../../lib/ai-extraction", () => ({
  extractArticleWithAi: vi.fn(async () => {
    state.aiCalls++;
    return null;
  }),
}));

vi.mock("../../lib/ssrf", async (importOriginal) => {
  const real = await importOriginal<typeof import("../../lib/ssrf")>();
  return {
    ...real,
    isTrustedFeedFetchingAllowed: vi.fn(async () => false),
    fetchTextWithSsrfProtection: vi.fn(async (_url: string, _init: unknown, opts: { impersonate?: boolean }) => {
      const transport = opts?.impersonate ? "impit" : "plain";
      state.calls.push(transport);
      const fn = state[transport];
      if (!fn) throw new Error("no transport stub");
      return fn();
    }),
  };
});
vi.mock("../../lib/render-sidecar", () => ({
  renderViaSidecar: vi.fn(async () => {
    state.calls.push("sidecar");
    return state.sidecar;
  }),
}));
vi.mock("../../lib/hosted-fetch", () => ({
  fetchViaHostedApiDetailed: vi.fn(),
  getHostedFetchConfigForUser: vi.fn(async () => null),
  HostedFetchRateLimitedError: class extends Error {},
}));

import { fetchAndExtractReadable, resetTransportMemory } from "../../lib/readability-extract";
import { HttpStatusError } from "../../lib/ssrf";
import { hostBackoffRemainingMs, resetHostBackoff } from "../../lib/host-backoff";

const P = (n: number) =>
  `<p>Paragraph ${n} of the investigation describes the new municipal heating network, its costs, the timeline and the objections raised by tenants in considerable detail.</p>`;
const ARTICLE = `<!doctype html><html><head><title>Heat</title></head><body><article><h1>Heating plan</h1>${Array.from({ length: 10 }, (_, i) => P(i)).join("")}</article></body></html>`;
const WALL = `<!doctype html><html><head><title>Consent</title></head><body><main><div><h2>Before you continue</h2><p>We and our 170 vendors use cookies and process personal data such as IP addresses for personalised ads and content. Click Accept all to give your consent, or manage your privacy settings.</p><button>Accept all</button></div></main></body></html>`;

const ok = (html: string) => async () => html;
const fail = (status: number) => async () => {
  throw new HttpStatusError(status, `Fetch failed: ${status}`);
};

describe("fetchAndExtractReadable escalation", () => {
  beforeEach(() => {
    state.impit = null;
    state.plain = null;
    state.sidecar = null;
    state.calls = [];
    state.aiCalls = 0;
    resetTransportMemory();
    resetHostBackoff();
  });

  it("falls back to the plain transport when the fingerprinted one is blocked (402), and remembers it", async () => {
    state.impit = fail(402);
    state.plain = ok(ARTICLE);
    const result = await fetchAndExtractReadable("https://blocked-impit.example/a");
    expect(result.quality?.verdict).toBe("good");
    expect(result.html).toContain("Paragraph 9");
    expect(state.calls).toEqual(["impit", "plain"]);
    expect(hostBackoffRemainingMs("https://blocked-impit.example/b")).toBe(0);

    // Next article on that host: the transport that worked goes first.
    state.calls = [];
    await fetchAndExtractReadable("https://blocked-impit.example/b");
    expect(state.calls).toEqual(["plain"]);
  });

  it("tries the other transport when the first one returns a consent wall", async () => {
    state.impit = ok(WALL);
    state.plain = ok(ARTICLE);
    const result = await fetchAndExtractReadable("https://wall.example/a");
    expect(result.quality?.verdict).toBe("good");
    expect(state.calls).toEqual(["impit", "plain"]);
  });

  it("escalates a wall on both transports to the render sidecar and picks the best candidate", async () => {
    state.impit = ok(WALL);
    state.plain = ok(WALL);
    state.sidecar = ARTICLE;
    const result = await fetchAndExtractReadable("https://wall-both.example/a");
    expect(state.calls).toEqual(["impit", "plain", "sidecar"]);
    expect(result.quality?.verdict).toBe("good");
    expect(result.html).toContain("Paragraph 3");
  });

  it("returns the (bad) best candidate when nothing better exists, so callers can record why", async () => {
    state.impit = ok(WALL);
    state.plain = ok(WALL);
    const result = await fetchAndExtractReadable("https://wall-only.example/a");
    expect(result.quality?.verdict).toBe("wall");
  });

  it("escalates a page that only repeats a short feed teaser, but not one that repeats a substantial feed item", async () => {
    const shortTeaser = Array.from({ length: 3 }, (_, i) => P(i)).join("");
    const teaserPage = `<!doctype html><html><body><article><h1>Heating plan</h1>${Array.from({ length: 4 }, (_, i) => P(i)).join("")}</article></body></html>`;
    state.impit = ok(teaserPage);
    state.plain = ok(teaserPage);
    await fetchAndExtractReadable("https://teaser.example/a", { baselineHtml: shortTeaser });
    expect(state.calls).toEqual(["impit", "plain", "sidecar"]);

    state.calls = [];
    const richFeed = Array.from({ length: 10 }, (_, i) => P(i)).join("");
    state.impit = ok(ARTICLE);
    await fetchAndExtractReadable("https://rich.example/a", { baselineHtml: richFeed });
    expect(state.calls).toEqual(["impit"]);
  });

  it("does not retry a permanent failure on another transport and backs the host off on blocks", async () => {
    state.impit = fail(404);
    state.plain = ok(ARTICLE);
    await expect(fetchAndExtractReadable("https://gone.example/a")).rejects.toThrow("Fetch failed: 404");
    expect(state.calls).toEqual(["impit", "sidecar"]);
    expect(hostBackoffRemainingMs("https://gone.example/a")).toBe(0);

    state.calls = [];
    state.impit = fail(429);
    state.plain = fail(429);
    await expect(fetchAndExtractReadable("https://busy.example/a")).rejects.toThrow("Fetch failed: 429");
    expect(hostBackoffRemainingMs("https://busy.example/other")).toBeGreaterThan(0);
  });

  it("bounds AI, render and hosted escalation by the shared per-sync budget", async () => {
    state.impit = ok(WALL);
    state.plain = ok(WALL);
    const budget = { ai: 1, render: 2, hosted: 0 };
    const ai = { provider: "openai" as const, apiKey: "k", usage: { userId: "u", feature: "extraction" as const } };
    for (let i = 0; i < 4; i++) {
      await fetchAndExtractReadable(`https://walled-${i}.example/a`, { aiExtraction: ai, escalationBudget: budget });
    }
    expect(state.aiCalls).toBe(1);
    expect(state.calls.filter((c) => c === "sidecar")).toHaveLength(2);
    expect(budget).toEqual({ ai: 0, render: 0, hosted: 0 });
  });
});
