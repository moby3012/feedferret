// @vitest-environment jsdom
// "↑ N neu" (PR 9): the pure buffering rules and the head probe hook — when it
// asks the server (only after a real counts response, only for the active
// pane, only online) and what `apply` writes into the list cache.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, createElement, useMemo } from "react";
import { createRoot, type Root } from "react-dom/client";
import { MutationObserver, QueryClient, QueryClientProvider, type InfiniteData } from "@tanstack/react-query";
import {
  AT_TOP_PX,
  appliedListData,
  bufferDecision,
  canAutoApply,
  formatNewCount,
  headUrl,
  probeApplies,
  probeWindow,
  MAX_EXCLUDED_IDS,
  scrollBehaviorFor,
} from "../../features/articles/new-items";
import { listKeyOf } from "../../features/articles/scope";
import { MARK_VIEW_READ_KEY, qk } from "../../features/articles/keys";
import { patchCachedArticle, patchCachedArticles } from "../../features/articles/cache";
import { registerStateBatcher } from "../../features/articles/batcher-registry";
import type { StateBatcher } from "../../features/articles/state-batcher";
import type { ArticleListItem, ArticlePage } from "../../features/articles/types";

vi.mock("@/features/offline/offline", () => ({
  fetchPageOrStored: vi.fn(),
  fetchDetailOrStored: vi.fn(),
  recordOpened: vi.fn(),
}));

import { useNewItemsProbe, type NewItemsProbe } from "../../features/articles/queries";

const ALL = listKeyOf({ kind: "all" }, "unread", "new");
const FEED = listKeyOf({ kind: "feed", id: "f1" }, "all", "new");

function item(id: string, createdAt: string): ArticleListItem {
  return {
    id,
    feedId: "f1",
    title: id,
    link: `https://example.test/${id}`,
    excerpt: "",
    author: null,
    publishedAt: createdAt,
    createdAt,
    imageUrl: null,
    kind: "article",
    media: null,
    readMinutes: null,
    isRead: false,
    isStarred: false,
    isReadLater: false,
    isSpoiler: false,
    isDuplicate: false,
    duplicateCount: 0,
    canonicalFeedName: null,
    labelIds: [],
  } as ArticleListItem;
}

describe("buffering rules", () => {
  it("caps the pill label at 99+", () => {
    expect(formatNewCount(0)).toBe("0");
    expect(formatNewCount(7)).toBe("7");
    expect(formatNewCount(99)).toBe("99");
    expect(formatNewCount(100)).toBe("99+");
    expect(formatNewCount(-3)).toBe("0");
  });

  it("probes only newest-first timelines", () => {
    expect(probeApplies(ALL)).toBe(true);
    expect(probeApplies(FEED)).toBe(true);
    expect(probeApplies(listKeyOf({ kind: "later" }, "all", "new"))).toBe(true);
    expect(probeApplies(listKeyOf({ kind: "all" }, "unread", "old"))).toBe(false);
    expect(probeApplies(listKeyOf({ kind: "recent" }, "all", "new"))).toBe(false);
    expect(probeApplies(listKeyOf({ kind: "query", q: "x" }, "all", "new"))).toBe(false);
    expect(probeApplies(null)).toBe(false);
  });

  it("keeps the window at the snapshot and excludes loaded rows past it", () => {
    const snap = Date.parse("2026-11-10T10:00:00Z");
    expect(probeWindow(null, [])).toEqual({ since: null, exclude: "" });
    expect(probeWindow(snap, [])).toEqual({ since: snap, exclude: "" });
    expect(probeWindow(snap, [item("a", "2026-11-10T09:00:00Z")])).toEqual({ since: snap, exclude: "" });
    // Synced while page 1 was being read / a back-dated row paged in later: on screen, so
    // excluded by id — the boundary itself never moves (a later page must not hide real arrivals).
    expect(probeWindow(snap, [item("a", "2026-11-10T09:00:00Z"), item("b", "2026-11-10T10:00:02Z"), item("c", "2026-11-10T10:05:00Z")])).toEqual({
      since: snap,
      exclude: "b,c",
    });
    expect(probeWindow(snap, [item("bad", "not a date")])).toEqual({ since: snap, exclude: "" });
    const many = Array.from({ length: MAX_EXCLUDED_IDS + 5 }, (_, i) => item(`n${i}`, "2026-11-10T11:00:00Z"));
    expect(probeWindow(snap, many).exclude.split(",")).toHaveLength(MAX_EXCLUDED_IDS);
  });

  it("inserts silently only at the very top with nothing under the finger", () => {
    const idleTop = { scrollTop: 0, pointerDown: false, gestureActive: false };
    expect(canAutoApply(idleTop)).toBe(true);
    expect(canAutoApply({ ...idleTop, scrollTop: AT_TOP_PX })).toBe(true);
    expect(canAutoApply({ ...idleTop, scrollTop: AT_TOP_PX + 1 })).toBe(false);
    expect(canAutoApply({ ...idleTop, pointerDown: true })).toBe(false);
    expect(canAutoApply({ ...idleTop, gestureActive: true })).toBe(false);
    // An article open in the reader: buffer only (prev / next must not shift).
    expect(canAutoApply({ ...idleTop, readerOpen: true })).toBe(false);
    expect(bufferDecision(3, { ...idleTop, readerOpen: true })).toBe("pill");

    expect(bufferDecision(0, idleTop)).toBe("none");
    expect(bufferDecision(3, idleTop)).toBe("apply");
    expect(bufferDecision(3, { ...idleTop, scrollTop: 2400 })).toBe("pill");
    expect(bufferDecision(3, { ...idleTop, pointerDown: true })).toBe("pill");
    expect(bufferDecision(3, null)).toBe("pill");
  });

  it("scrolls back smoothly only over short distances", () => {
    expect(scrollBehaviorFor(1000, 800)).toBe("smooth");
    expect(scrollBehaviorFor(2399, 800)).toBe("smooth");
    expect(scrollBehaviorFor(2400, 800)).toBe("instant");
  });

  it("builds the head URL from the list key", () => {
    expect(headUrl(ALL, 1234.9)).toBe("/api/app/articles/head?show=unread&sort=new&since=1234");
    expect(headUrl(FEED, 5)).toBe("/api/app/articles/head?feed=f1&show=all&sort=new&since=5");
    expect(headUrl(FEED, 5, "a,b")).toBe("/api/app/articles/head?feed=f1&show=all&sort=new&since=5&x=a%2Cb");
  });

  it("an applied list is the fresh first page alone", () => {
    const page: ArticlePage = { items: [], nextCursor: "c", snapshotAt: 9 };
    expect(appliedListData(page)).toEqual({ pages: [page], pageParams: [null] });
  });
});

// ------------------------------------------------------------------ hook

let root: Root;
let host: HTMLDivElement;
let qc: QueryClient;
let fetchMock: ReturnType<typeof vi.fn>;
const result: { current: NewItemsProbe | null } = { current: null };

function Probe(p: { listKey: typeof ALL | null; since: number | null; active: boolean; exclude?: string }) {
  const win = useMemo(() => ({ since: p.since, exclude: p.exclude ?? "" }), [p.since, p.exclude]);
  result.current = useNewItemsProbe(p.listKey, win, { active: p.active });
  return null;
}

function render(p: { listKey: typeof ALL | null; since: number | null; active: boolean; exclude?: string }) {
  act(() => root.render(createElement(QueryClientProvider, { client: qc }, createElement(Probe, p))));
}

const headCalls = () => fetchMock.mock.calls.map((c) => String(c[0])).filter((u) => u.startsWith("/api/app/articles/head"));

async function countsFetch() {
  await act(async () => {
    // networkMode "always": a counts answer even offline — the probe's own gate is under test.
    await qc.fetchQuery({ queryKey: qk.counts, queryFn: async () => ({ unreadTotal: 1 }), staleTime: 0, networkMode: "always" });
  });
  await act(async () => {
    await new Promise((r) => setTimeout(r, 0));
  });
}

function setOnline(online: boolean) {
  Object.defineProperty(window.navigator, "onLine", { configurable: true, get: () => online });
  window.dispatchEvent(new Event(online ? "online" : "offline"));
}

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
  qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  setOnline(true);
  fetchMock = vi.fn(async (url: string) => {
    const body = url.startsWith("/api/app/articles/head")
      ? { count: 4, newestCursor: "99" }
      : { items: [item("new", "2026-11-10T11:00:00Z")], nextCursor: null, snapshotAt: 42 };
    return new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
  });
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
  act(() => root.unmount());
  host.remove();
  qc.clear();
  vi.unstubAllGlobals();
});

describe("useNewItemsProbe", () => {
  it("does not ask the server on bind — a fresh snapshot has nothing newer", async () => {
    render({ listKey: ALL, since: 1000, active: true });
    await act(async () => {
      await new Promise((r) => setTimeout(r, 10));
    });
    expect(headCalls()).toEqual([]);
    expect(result.current?.count).toBe(0);
  });

  it("probes once after every real counts response, not after optimistic counts patches", async () => {
    render({ listKey: ALL, since: 1000, active: true });
    act(() => {
      qc.setQueryData(qk.counts, { unreadTotal: 7 });
    });
    expect(headCalls()).toEqual([]);

    await countsFetch();
    await vi.waitFor(() => expect(result.current?.count).toBe(4));
    expect(headCalls()).toEqual(["/api/app/articles/head?show=unread&sort=new&since=1000"]);
  });

  it("stays silent for inactive panes, search / oldest-first lists and without a snapshot", async () => {
    render({ listKey: ALL, since: 1000, active: false });
    await countsFetch();
    render({ listKey: listKeyOf({ kind: "query", q: "x" }, "all", "new"), since: 1000, active: true });
    await countsFetch();
    render({ listKey: listKeyOf({ kind: "all" }, "unread", "old"), since: 1000, active: true });
    await countsFetch();
    render({ listKey: ALL, since: null, active: true });
    await countsFetch();
    expect(headCalls()).toEqual([]);
    expect(result.current?.count).toBe(0);
  });

  it("pauses offline and resumes when back online", async () => {
    render({ listKey: ALL, since: 1000, active: true });
    act(() => setOnline(false));
    await countsFetch();
    expect(headCalls()).toEqual([]);
    expect(result.current?.count).toBe(0);

    act(() => setOnline(true));
    await countsFetch();
    await vi.waitFor(() => expect(result.current?.count).toBe(4));
    expect(headCalls()).toHaveLength(1);
  });

  it("apply replaces the snapshot with a fresh first page (and the window moves on)", async () => {
    const old: InfiniteData<ArticlePage, string | null> = {
      pages: [
        { items: [item("a", "2026-11-10T09:00:00Z")], nextCursor: "p2", snapshotAt: 1000 },
        { items: [item("b", "2026-11-10T08:00:00Z")], nextCursor: null },
      ],
      pageParams: [null, "p2"],
    };
    qc.setQueryData(qk.list(ALL), old);
    render({ listKey: ALL, since: 1000, active: true });
    await act(async () => {
      expect(await result.current!.apply()).toBe(true);
    });
    const data = qc.getQueryData<InfiniteData<ArticlePage, string | null>>(qk.list(ALL))!;
    expect(data.pageParams).toEqual([null]);
    expect(data.pages).toHaveLength(1);
    expect(data.pages[0].items.map((i) => i.id)).toEqual(["new"]);
    expect(data.pages[0].snapshotAt).toBe(42);
    expect(fetchMock.mock.calls.map((c) => String(c[0]))).toEqual(["/api/app/articles?show=unread&sort=new&limit=50"]);
  });

  it("asks the server to skip loaded rows past the snapshot", async () => {
    render({ listKey: ALL, since: 1000, active: true, exclude: "b,c" });
    await countsFetch();
    await vi.waitFor(() => expect(headCalls()).toEqual(["/api/app/articles/head?show=unread&sort=new&since=1000&x=b%2Cc"]));
  });

  it("recheck probes now and joins a probe already on the wire", async () => {
    render({ listKey: ALL, since: 1000, active: true });
    let count = 0;
    await act(async () => {
      const a = result.current!.recheck();
      const b = result.current!.recheck();
      count = (await Promise.all([a, b]))[0];
    });
    expect(count).toBe(4);
    expect(headCalls()).toHaveLength(1);
    // Lists without a probe: 0, no request.
    render({ listKey: listKeyOf({ kind: "query", q: "x" }, "all", "new"), since: 1000, active: true });
    await act(async () => {
      count = await result.current!.recheck();
    });
    expect(count).toBe(0);
    expect(headCalls()).toHaveLength(1);
  });

  it("apply keeps the old snapshot when the commit check fails (scrolled / touched while on the wire)", async () => {
    const old: InfiniteData<ArticlePage, string | null> = { pages: [{ items: [item("a", "2026-11-10T09:00:00Z")], nextCursor: null, snapshotAt: 1000 }], pageParams: [null] };
    qc.setQueryData(qk.list(ALL), old);
    render({ listKey: ALL, since: 1000, active: true });
    let applied: boolean | null = null;
    await act(async () => {
      applied = await result.current!.apply(() => false);
    });
    expect(applied).toBe(false);
    expect(qc.getQueryData(qk.list(ALL))).toBe(old);
  });

  it("apply replays row rewrites made while page 1 was on the wire (a toggle settled meanwhile is kept)", async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    fetchMock.mockImplementation(async (url: string) => {
      await gate;
      // The server read happened before the writes below: the page has the old flags.
      const body = { items: [item("new", "2026-11-10T11:00:00Z"), item("a", "2026-11-10T09:00:00Z")], nextCursor: null, snapshotAt: 42 };
      return new Response(JSON.stringify(url.startsWith("/api/app/articles/head") ? { count: 0, newestCursor: null } : body), { status: 200 });
    });
    qc.setQueryData(qk.list(ALL), { pages: [{ items: [item("a", "2026-11-10T09:00:00Z")], nextCursor: null, snapshotAt: 1000 }], pageParams: [null] });
    render({ listKey: ALL, since: 1000, active: true });
    let done!: Promise<boolean>;
    await act(async () => {
      done = result.current!.apply();
      await new Promise((r) => setTimeout(r, 0));
    });
    // A toggle (row known only in the old snapshot) and a bulk mark-read (row known nowhere yet).
    act(() => {
      patchCachedArticle(qc, "a", { isStarred: true });
      patchCachedArticles(qc, ["new"], { isRead: true });
    });
    await act(async () => {
      release();
      await done;
    });
    const rows = qc.getQueryData<InfiniteData<ArticlePage, string | null>>(qk.list(ALL))!.pages[0].items;
    expect(rows.find((r) => r.id === "a")?.isStarred).toBe(true);
    expect(rows.find((r) => r.id === "new")?.isRead).toBe(true);
  });

  it("apply waits for unsettled writes before reading page 1", async () => {
    let idle = false;
    let settle!: () => void;
    const idlePromise = new Promise<void>((r) => (settle = r));
    const batcher = { isIdle: () => idle, whenIdle: () => idlePromise, latestValue: () => undefined } as unknown as StateBatcher;
    registerStateBatcher(qc, batcher);
    let bulkDone!: () => void;
    const bulk = new MutationObserver(qc, { mutationKey: MARK_VIEW_READ_KEY, mutationFn: () => new Promise<void>((r) => (bulkDone = r)) });
    void bulk.mutate();
    render({ listKey: ALL, since: 1000, active: true });
    let done!: Promise<boolean>;
    await act(async () => {
      done = result.current!.apply();
      await new Promise((r) => setTimeout(r, 10));
    });
    const listCalls = () => fetchMock.mock.calls.filter((c) => String(c[0]).startsWith("/api/app/articles?"));
    expect(listCalls()).toHaveLength(0);
    await act(async () => {
      idle = true;
      settle();
      await new Promise((r) => setTimeout(r, 10));
    });
    // The bulk mark-read is still in flight.
    expect(listCalls()).toHaveLength(0);
    await act(async () => {
      bulkDone();
      await done;
    });
    expect(listCalls()).toHaveLength(1);
  });
});
