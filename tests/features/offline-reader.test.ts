import "fake-indexeddb/auto";
import { readFileSync } from "node:fs";
import { JSDOM } from "jsdom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ArticleDetail } from "@/features/articles/types";
import {
  BODY_STORE,
  INDEX_STORE,
  META_STORE,
  SESSION_KEY,
  claimSession,
  clearAllOffline,
  readSession,
  listRows,
  resetOfflineDbForTests,
  saveArticle,
  type OfflineScope,
} from "@/features/offline/store";

// public/offline-reader.js against the real offline.html in jsdom, with the app's own store (fake-indexeddb) as the
// data source. Covers the authorization policy and the re-validation triggers (pageshow incl. BFCache restores,
// visibility, cross-tab session signals, opening a body) — the DOM must be emptied at once, not only the DB.

const HTML = readFileSync("public/offline.html", "utf8");
const SOURCE = readFileSync("public/offline-reader.js", "utf8").replace(/^\s*$/gm, "");

function detail(id: string, o: Partial<ArticleDetail> = {}): ArticleDetail {
  return {
    id,
    feedId: "f1",
    title: `Title ${id}`,
    link: `https://example.com/${id}`,
    excerpt: "excerpt",
    author: null,
    publishedAt: "2026-01-01T00:00:00.000Z",
    createdAt: "2026-01-01T00:00:00.000Z",
    imageUrl: null,
    kind: "article",
    media: null,
    readMinutes: 3,
    isRead: false,
    isStarred: false,
    isReadLater: true,
    isSpoiler: false,
    isDuplicate: false,
    duplicateCount: 0,
    canonicalFeedName: null,
    labelIds: [],
    html: `<p>SECRET body of ${id}</p>`,
    contentFormat: "html",
    aiSummary: null,
    aiSummarizedAt: null,
    readAt: null,
    ...o,
  } as ArticleDetail;
}

async function claim(userId: string): Promise<OfflineScope> {
  const claimed = await claimSession(userId);
  return { userId, gen: claimed!.gen };
}

async function seed(userId: string, ids: string[]): Promise<OfflineScope> {
  const scope = await claim(userId);
  for (const id of ids) await saveArticle(scope, detail(`${userId}-${id}`), { readLater: true });
  return scope;
}

type Account = { userId: string } | "unauthorized" | "down";

interface Page {
  dom: JSDOM;
  win: Window & typeof globalThis;
  $: (id: string) => HTMLElement;
  fetchMock: ReturnType<typeof vi.fn>;
  /** Who the server says is signed in (and when it is asked). */
  server: { account: Account; hold: Promise<void> | null };
  items: () => string[];
  /** True when nothing of the store's content is left anywhere in the DOM. */
  empty: () => boolean;
}

const pages: Page[] = [];
const channels: BroadcastChannel[] = [];

function openPage(opts: { slow?: boolean; account?: Account; online?: boolean; holdFirst?: Promise<void>; then?: Account } = {}): Page {
  const dom = new JSDOM(HTML, { url: "https://feed.test/offline.html", runScripts: "outside-only", pretendToBeVisual: true });
  const win = dom.window as unknown as Window & typeof globalThis & Record<string, unknown>;
  const server: Page["server"] = { account: opts.account ?? { userId: "A" }, hold: null };
  let calls = 0;
  const fetchMock = vi.fn(async () => {
    const first = calls++ === 0;
    if (first && opts.holdFirst) await opts.holdFirst; // A's verification: slow
    if (server.hold) await server.hold;
    const account = first || !opts.then ? server.account : opts.then;
    if (account === "down") throw new TypeError("Failed to fetch");
    if (account === "unauthorized") return { status: 401, ok: false, json: async () => ({}) };
    return { status: 200, ok: true, json: async () => ({ userId: account.userId }) };
  });
  Object.assign(win, {
    indexedDB: globalThis.indexedDB,
    IDBKeyRange: globalThis.IDBKeyRange,
    fetch: fetchMock,
    BroadcastChannel: class extends globalThis.BroadcastChannel {
      constructor(name: string) {
        super(name);
        channels.push(this);
      }
    },
  });
  if (opts.online === false) Object.defineProperty(win.navigator, "onLine", { value: false, configurable: true });
  if (opts.slow) win.document.body.setAttribute("data-mode", "slow");
  win.eval(SOURCE);
  const $ = (id: string) => win.document.getElementById(id) as HTMLElement;
  const page: Page = {
    dom,
    win,
    $,
    fetchMock,
    server,
    items: () => Array.from(win.document.querySelectorAll("#sections li")).map((li) => li.textContent ?? ""),
    empty: () =>
      $("sections").childElementCount === 0 &&
      $("r-title").textContent === "" &&
      $("r-meta").textContent === "" &&
      !$("body").hasAttribute("srcdoc") &&
      $("reader").hidden === true,
  };
  pages.push(page);
  return page;
}

const settle = (check: () => void) => vi.waitFor(check, { timeout: 4000, interval: 10 });

function fire(page: Page, type: string, props: Record<string, unknown> = {}) {
  const event = new page.win.Event(type);
  for (const [key, value] of Object.entries(props)) Object.defineProperty(event, key, { value });
  page.win.dispatchEvent(event);
}
const pageshow = (page: Page, persisted: boolean) => fire(page, "pageshow", { persisted });
const becomeVisible = (page: Page) => page.win.document.dispatchEvent(new page.win.Event("visibilitychange"));

async function openFirstArticle(page: Page) {
  (page.win.document.querySelector("#sections li button") as HTMLButtonElement).click();
  await settle(() => expect(page.$("reader").hidden).toBe(false));
  await settle(() => expect(page.$("body").getAttribute("srcdoc")).toContain("SECRET body"));
}

beforeEach(async () => {
  await resetOfflineDbForTests();
  await clearAllOffline();
});

afterEach(async () => {
  vi.restoreAllMocks();
  // Windows are left to the GC on purpose: closing one under an in-flight refresh would throw inside the page script.
  for (const channel of channels.splice(0)) channel.close();
  pages.length = 0;
});

describe("offline reader: authorization policy", () => {
  it("shows the stored lists of the verified account", async () => {
    await seed("A", ["1", "2"]);
    const page = openPage();
    await settle(() => expect(page.items()).toHaveLength(2));
    expect(page.fetchMock).toHaveBeenCalledWith("/api/app/session", expect.anything());
  });

  it("401 clears the store and the DOM", async () => {
    await seed("A", ["1"]);
    const page = openPage({ account: "unauthorized" });
    await settle(() => expect(page.$("intro").textContent).toContain("no longer valid"));
    expect(page.items()).toEqual([]);
    expect(page.$("login").hidden).toBe(false);
    expect(await listRows("A")).toEqual([]);
    expect(await readSession()).toBeUndefined();
  });

  it("an expired session is neither shown nor kept, also without network", async () => {
    const scope = await seed("A", ["1"]);
    await ageSession(scope, Date.now() - 31 * 24 * 3600_000);
    const page = openPage({ online: false });
    await settle(() => expect(page.$("intro").textContent).toContain("expired"));
    expect(page.items()).toEqual([]);
    expect(await readSession()).toBeUndefined();
  });
});

describe("offline reader: clearing is bound to the judged session (userId, gen)", () => {
  it("A's delayed 401 never wipes the data B claimed in the meantime (the page then judges B from the top)", async () => {
    await seed("A", ["1"]);
    let release!: () => void;
    const page = openPage({ account: "unauthorized", holdFirst: new Promise<void>((resolve) => (release = resolve)), then: { userId: "B" } });
    await settle(() => expect(page.fetchMock).toHaveBeenCalledTimes(1)); // A's verification is in flight
    const b = await seed("B", ["1"]); // B signs in on the device and claims the DB
    release(); // A's 401 arrives now
    await settle(() => expect(page.items()).toHaveLength(1));
    // B's data is untouched and is what the page shows.
    expect((await readSession())?.gen).toBe(b.gen);
    expect((await listRows("B")).map((r) => r.id)).toEqual(["B-1"]);
    expect(page.items().join()).toContain("Title B-1");
    expect(page.items().join()).not.toContain("Title A-1");
  });

  it("a stale 401 for A leaves B's data alone even when B cannot be verified afterwards (server down)", async () => {
    await seed("A", ["1"]);
    let release!: () => void;
    const page = openPage({ account: "unauthorized", holdFirst: new Promise<void>((resolve) => (release = resolve)), then: "down" });
    await settle(() => expect(page.fetchMock).toHaveBeenCalledTimes(1));
    const b = await seed("B", ["1"]);
    release();
    await settle(() => expect(page.fetchMock).toHaveBeenCalledTimes(2));
    await settle(() => expect(page.items().join()).toContain("Title B-1")); // unverifiable but fresh: shown per policy
    expect((await readSession())?.gen).toBe(b.gen);
    expect((await listRows("B")).length).toBe(1);
    expect(page.items().join()).not.toContain("Title A-1");
  });

  it("the expiry path is gated too: B claims the DB between A's read and A's clear", async () => {
    const a = await seed("A", ["1"]);
    await ageSession(a, Date.now() - 31 * 24 * 3600_000);
    // Interleave deterministically: the moment the reader opens its read transaction, queue B's claim right behind it
    // (IndexedDB runs overlapping readwrite transactions in creation order, so it lands before the reader's clear).
    const real = IDBDatabase.prototype.transaction;
    let armed = true;
    let claimed: Promise<void> | null = null;
    vi.spyOn(IDBDatabase.prototype, "transaction").mockImplementation(function (this: IDBDatabase, names: string | string[], mode?: IDBTransactionMode) {
      const tx = real.call(this, names, mode);
      const list = Array.isArray(names) ? names : [names];
      if (armed && mode === "readonly" && list.includes(INDEX_STORE) && list.includes(META_STORE)) {
        armed = false;
        claimed = claimRaw(this, "B");
      }
      return tx;
    } as unknown as typeof IDBDatabase.prototype.transaction);

    const page = openPage({ account: { userId: "B" } });
    await settle(() => expect(claimed).not.toBeNull());
    await claimed;
    await settle(() => expect(page.items()).toHaveLength(1));
    expect((await readSession())?.userId).toBe("B");
    expect((await listRows("B")).map((r) => r.id)).toEqual(["B-1"]);
    expect(page.items().join()).toContain("Title B-1");
  });

  it("expiry never wipes data the app re-verified in the meantime", async () => {
    const a = await seed("A", ["1"]);
    await ageSession(a, Date.now() - 31 * 24 * 3600_000);
    const real = IDBDatabase.prototype.transaction;
    let armed = true;
    let refreshed: Promise<void> | null = null;
    vi.spyOn(IDBDatabase.prototype, "transaction").mockImplementation(function (this: IDBDatabase, names: string | string[], mode?: IDBTransactionMode) {
      const tx = real.call(this, names, mode);
      const list = Array.isArray(names) ? names : [names];
      if (armed && mode === "readonly" && list.includes(INDEX_STORE) && list.includes(META_STORE)) {
        armed = false;
        refreshed = reverifyRaw(this);
      }
      return tx;
    } as unknown as typeof IDBDatabase.prototype.transaction);
    const page = openPage({ account: { userId: "A" } });
    await settle(() => expect(refreshed).not.toBeNull());
    await refreshed;
    await settle(() => expect(page.items()).toHaveLength(1));
    expect((await listRows("A")).length).toBe(1);
  });
});

describe("offline reader: re-validation while the page is open", () => {
  async function shown(opts: Parameters<typeof openPage>[0] = {}) {
    const a = await seed("A", ["1", "2"]);
    const page = openPage(opts);
    await settle(() => expect(page.items()).toHaveLength(2));
    return { page, a };
  }

  it("BFCache restore (pageshow persisted=true) after logout: the rendered lists are gone at once, even offline", async () => {
    const { page } = await shown();
    await clearAllOffline(); // signed out elsewhere while this page sat frozen in the BFCache
    Object.defineProperty(page.win.navigator, "onLine", { value: false, configurable: true });
    pageshow(page, true);
    await settle(() => expect(page.empty()).toBe(true));
    expect(page.items()).toEqual([]);
    expect(page.$("intro").textContent).toContain("no longer valid");
    expect(page.$("login").hidden).toBe(false);
    expect(page.win.document.body.hasAttribute("data-checking")).toBe(false);
  });

  it("BFCache restore hides the stale content while the session is being checked", async () => {
    const { page } = await shown();
    let release!: () => void;
    page.server.hold = new Promise<void>((resolve) => (release = resolve));
    pageshow(page, true);
    expect(page.win.document.body.hasAttribute("data-checking")).toBe(true);
    release();
    await settle(() => expect(page.win.document.body.hasAttribute("data-checking")).toBe(false));
    expect(page.items()).toHaveLength(2); // still the same, valid session
  });

  it("BFCache restore after another account took over the device: A's lists are replaced, never mixed", async () => {
    const { page } = await shown();
    await seed("B", ["9"]); // B signed in elsewhere → new generation
    page.server.account = { userId: "B" };
    pageshow(page, true);
    await settle(() => expect(page.items().join()).toContain("Title B-9"));
    expect(page.items().join()).not.toContain("Title A-");
    expect(page.items()).toHaveLength(1);
  });

  it("BFCache restore: the server says the session is dead (store still there) → cleared + locked", async () => {
    const { page } = await shown();
    page.server.account = "unauthorized";
    pageshow(page, true);
    await settle(() => expect(page.empty()).toBe(true));
    expect(page.$("intro").textContent).toContain("no longer valid");
    expect(await listRows("A")).toEqual([]);
  });

  it("an ordinary pageshow of the initial load does not authorize twice", async () => {
    const { page } = await shown();
    const calls = page.fetchMock.mock.calls.length;
    pageshow(page, false);
    await new Promise((r) => setTimeout(r, 30));
    expect(page.fetchMock.mock.calls.length).toBe(calls);
  });

  it("visibilitychange → visible re-validates (session expired meanwhile → DOM emptied)", async () => {
    const { page, a } = await shown({ online: false });
    await ageSession(a, Date.now() - 31 * 24 * 3600_000);
    becomeVisible(page);
    await settle(() => expect(page.empty()).toBe(true));
    expect(page.$("intro").textContent).toContain("expired");
    expect(await readSession()).toBeUndefined();
  });

  it("BroadcastChannel session signal (sign-out in another tab) empties the DOM", async () => {
    const { page } = await shown({ online: false });
    await clearAllOffline();
    const channel = new BroadcastChannel("feedferret-offline-session");
    channel.postMessage({ gen: null });
    channel.close();
    await settle(() => expect(page.empty()).toBe(true));
    expect(page.$("intro").textContent).toContain("no longer valid");
  });

  it("storage session signal (browsers without BroadcastChannel) empties the DOM", async () => {
    const { page } = await shown({ online: false });
    await clearAllOffline();
    page.win.dispatchEvent(new page.win.StorageEvent("storage", { key: "feedferret:offline-session-signal", newValue: JSON.stringify({ gen: null }) }));
    await settle(() => expect(page.empty()).toBe(true));
    // an unrelated key does nothing
    const calls = page.fetchMock.mock.calls.length;
    page.win.dispatchEvent(new page.win.StorageEvent("storage", { key: "other", newValue: "x" }));
    expect(page.fetchMock.mock.calls.length).toBe(calls);
  });

  it("an open article disappears (iframe included) when the session ends", async () => {
    const { page } = await shown({ online: false });
    await openFirstArticle(page);
    expect(page.$("r-title").textContent).toMatch(/^Title A-/);
    await clearAllOffline();
    becomeVisible(page);
    await settle(() => expect(page.empty()).toBe(true));
    expect(page.win.location.hash).toBe("");
    expect(page.win.document.documentElement.innerHTML).not.toContain("SECRET body");
  });

  it("an open article of A is gone after the account switched, and B's list takes its place", async () => {
    const { page } = await shown();
    await openFirstArticle(page);
    await seed("B", ["1"]);
    page.server.account = { userId: "B" };
    pageshow(page, true);
    await settle(() => expect(page.items().join()).toContain("Title B-1"));
    expect(page.$("reader").hidden).toBe(true);
    expect(page.$("r-title").textContent).toBe("");
    expect(page.$("body").hasAttribute("srcdoc")).toBe(false);
    expect(page.win.location.hash).toBe("");
  });

  it("no body is opened for a session that is gone: the click locks the page instead", async () => {
    const { page } = await shown({ online: false });
    await clearAllOffline(); // no event reached this tab
    (page.win.document.querySelector("#sections li button") as HTMLButtonElement).click();
    await settle(() => expect(page.empty()).toBe(true));
    expect(page.$("intro").textContent).toContain("no longer valid");
    expect(page.$("reader").hidden).toBe(true);
  });

  it("no body is opened for an expired session either", async () => {
    const { page, a } = await shown({ online: false });
    await ageSession(a, Date.now() - 31 * 24 * 3600_000);
    (page.win.document.querySelector("#sections li button") as HTMLButtonElement).click();
    await settle(() => expect(page.empty()).toBe(true));
    await settle(() => expect(page.$("intro").textContent).toContain("expired"));
    expect(await readSession()).toBeUndefined();
  });

  it("no body is opened once another account owns the store: A's page is replaced by the store's current owner", async () => {
    const { page } = await shown({ online: false });
    await seed("B", ["1"]);
    (page.win.document.querySelector("#sections li button") as HTMLButtonElement).click();
    await settle(() => expect(page.items().join()).toContain("Title B-1"));
    expect(page.$("reader").hidden).toBe(true);
    expect(page.$("body").hasAttribute("srcdoc")).toBe(false);
    expect(page.win.document.documentElement.innerHTML).not.toContain("A-1");
  });

  it("an unchanged session keeps the page as it is (reading position and open article survive a refresh)", async () => {
    const { page } = await shown();
    await openFirstArticle(page);
    becomeVisible(page);
    await settle(() => expect(page.fetchMock.mock.calls.length).toBeGreaterThan(1));
    await new Promise((r) => setTimeout(r, 30));
    expect(page.$("reader").hidden).toBe(false);
    expect(page.$("body").getAttribute("srcdoc")).toContain("SECRET body");
  });

  it("slow mode: lists stay hidden until the visitor chooses the offline view; a revoked session shows nothing then", async () => {
    await seed("A", ["1"]);
    const page = openPage({ slow: true });
    await settle(() => expect(page.fetchMock).toHaveBeenCalled());
    expect(page.$("slow").hidden).toBe(false);
    expect(page.$("lists").hidden).toBe(true);
    (page.$("show-offline") as HTMLButtonElement).click();
    await settle(() => expect(page.items()).toHaveLength(1));
    expect(page.$("lists").hidden).toBe(false);
    expect(page.$("slow").hidden).toBe(true);

    // sign-out → also in slow mode the DOM is emptied
    await clearAllOffline();
    page.server.account = "unauthorized";
    pageshow(page, true);
    await settle(() => expect(page.empty()).toBe(true));
  });
});

// ---------------------------------------------------------------- helpers

/** Rewrites session.verifiedAt through the app's own DB connection. */
async function ageSession(scope: OfflineScope, verifiedAt: number) {
  const db = await rawDb();
  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction([META_STORE], "readwrite");
    const meta = tx.objectStore(META_STORE);
    meta.put({ userId: scope.userId, gen: scope.gen, verifiedAt }, SESSION_KEY);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
  db.close();
}

function rawDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const open = indexedDB.open("feedferret-offline");
    open.onsuccess = () => resolve(open.result);
    open.onerror = () => reject(open.error);
  });
}

/** What claimSession("B") does, issued on the reader's own connection so it can be ordered right behind its read. */
function claimRaw(db: IDBDatabase, userId: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const tx = db.transaction([INDEX_STORE, BODY_STORE, META_STORE], "readwrite");
    tx.objectStore(INDEX_STORE).clear();
    tx.objectStore(BODY_STORE).clear();
    tx.objectStore(META_STORE).clear();
    tx.objectStore(META_STORE).put({ userId, gen: "gen-of-" + userId, verifiedAt: Date.now() }, SESSION_KEY);
    const item = detail(`${userId}-1`);
    tx.objectStore(INDEX_STORE).put(
      { key: `${userId}:${item.id}`, userId, id: item.id, item, readLater: true, savedAt: 1, lastAccess: 1, openedAt: null, bytes: 10 },
    );
    tx.objectStore(BODY_STORE).put(item, `${userId}:${item.id}`);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

/** The app re-verifies the very same session (same user, same gen) with a fresh timestamp. */
function reverifyRaw(db: IDBDatabase): Promise<void> {
  return new Promise((resolve, reject) => {
    const tx = db.transaction([META_STORE], "readwrite");
    const meta = tx.objectStore(META_STORE);
    const get = meta.get(SESSION_KEY);
    get.onsuccess = () => meta.put({ ...get.result, verifiedAt: Date.now() }, SESSION_KEY);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}
