import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MemoryHistory, installMemoryWindow, settle } from "../helpers/memory-history";

// Nav store against an in-memory history (.pm/spec-shell-design.md §1.4):
// stack seeding, breakpoint reconciliation, overlays and "Back never traps".

const layout = vi.hoisted(() => ({
  current: "compact" as "compact" | "medium" | "expanded",
  coarse: false,
  listeners: new Set<() => void>(),
}));

vi.mock("@/features/reader/layout/layout-class", () => ({
  getLayoutClass: () => layout.current,
  isCompactLayout: () => layout.current === "compact",
  isCoarsePointer: () => layout.coarse,
  subscribeLayoutClass: (fn: () => void) => {
    layout.listeners.add(fn);
    return () => layout.listeners.delete(fn);
  },
  useLayoutClass: () => layout.current,
}));

type Store = typeof import("../../features/reader/nav/store");

let history: MemoryHistory;
let uninstall: () => void;
let store: Store;
let stop: () => void;

async function boot(path: string, as: "compact" | "medium" | "expanded" = "compact") {
  layout.current = as;
  history = new MemoryHistory(path);
  uninstall = installMemoryWindow(history);
  vi.resetModules();
  store = await import("../../features/reader/nav/store");
  stop = store.bootNav(() => {});
  await settle();
}

async function resize(to: "compact" | "medium" | "expanded") {
  layout.current = to;
  layout.listeners.forEach((l) => l());
  await settle();
}

/** System back (edge-swipe / back key): a traversal the app did not start. */
async function systemBack() {
  history.back();
  await settle();
}

const nav = () => store.getNavState();
const here = () => store.getNavState().loc;

beforeEach(() => {
  layout.coarse = false;
  layout.listeners.clear();
});

afterEach(() => {
  stop?.();
  uninstall?.();
});

describe("deep-link stack seeding", () => {
  it("compact /?feed=F&a=X seeds Feeds root → feed → article, and Back eventually leaves the app", async () => {
    await boot("/?feed=F&a=X");
    expect(history.backStack()).toEqual(["/?tab=feeds", "/?feed=F", "/?feed=F&a=X"]);
    expect(nav().index).toBe(2);

    await systemBack();
    expect(history.here()).toBe("/?feed=F");
    expect(here().articleId).toBeNull();
    await systemBack();
    expect(history.here()).toBe("/?tab=feeds");
    expect(nav().index).toBe(0);
    await systemBack();
    expect(history.exited).toBe(true); // no trap: the tab root's Back leaves
  });

  it("a tab root keeps its article: /?tab=feeds&a=X seeds the root beneath it", async () => {
    await boot("/?tab=feeds&a=X");
    expect(history.backStack()).toEqual(["/?tab=feeds", "/?tab=feeds&a=X"]);
    expect(here()).toMatchObject({ tab: "feeds", scope: null, articleId: "X" });
    await systemBack();
    expect(history.here()).toBe("/?tab=feeds");
    await systemBack();
    expect(history.exited).toBe(true);
  });

  it("UI up() walks the same levels and never writes past the root", async () => {
    await boot("/?feed=F&a=X");
    await store.nav.up();
    expect(history.here()).toBe("/?feed=F");
    await store.nav.up();
    expect(history.here()).toBe("/?tab=feeds");
    await store.nav.up(); // root: nothing above, no synthetic entry
    expect(history.here()).toBe("/?tab=feeds");
    expect(history.length).toBe(4);
    await systemBack();
    expect(history.exited).toBe(true);
  });
});

describe("crossing the compact breakpoint reconciles the owned stack", () => {
  it("wide /?feed=F resized to compact: Back goes to the Feeds root, then leaves", async () => {
    await boot("/?feed=F", "expanded");
    expect(history.backStack()).toEqual(["/?feed=F"]);
    expect(nav().index).toBe(0);

    await resize("compact");
    expect(history.backStack()).toEqual(["/?tab=feeds", "/?feed=F"]);
    expect(nav().index).toBe(1);
    expect(history.here()).toBe("/?feed=F");

    await systemBack();
    expect(here()).toMatchObject({ tab: "feeds", scope: null });
    await systemBack();
    expect(history.exited).toBe(true);
  });

  it("wide feed + article resized to compact gains the Feeds root level", async () => {
    await boot("/?feed=F", "medium");
    await store.nav.openArticle("X");
    expect(history.backStack()).toEqual(["/?feed=F", "/?feed=F&a=X"]);
    await resize("compact");
    expect(history.backStack()).toEqual(["/?tab=feeds", "/?feed=F", "/?feed=F&a=X"]);
    expect(nav().index).toBe(2);
    expect(here().articleId).toBe("X");
  });

  it("compact feed resized to wide drops the Feeds root level", async () => {
    await boot("/?feed=F");
    expect(history.backStack()).toEqual(["/?tab=feeds", "/?feed=F"]);
    await resize("expanded");
    expect(history.backStack()).toEqual(["/?feed=F"]);
    expect(nav().index).toBe(0);
    await systemBack();
    expect(history.exited).toBe(true);
  });

  it("medium ⇄ expanded is not a depth change (nothing rewritten)", async () => {
    await boot("/?feed=F", "medium");
    const before = history.length;
    await resize("expanded");
    expect(history.length).toBe(before);
    expect(nav().index).toBe(0);
  });

  it("an open overlay survives the rewrite", async () => {
    await boot("/?feed=F", "expanded");
    layout.coarse = true;
    await store.nav.openOverlay("sources");
    expect(history.backStack()).toEqual(["/?feed=F", "/?feed=F"]);
    await resize("compact");
    expect(nav().overlay).toBe("sources");
    expect(history.backStack()).toEqual(["/?tab=feeds", "/?feed=F", "/?feed=F"]);
    await systemBack(); // closes the overlay, stays on the feed
    expect(nav().overlay).toBeNull();
    expect(history.here()).toBe("/?feed=F");
  });
});

describe("overlays", () => {
  it("system Back closes an overlay without navigating beneath it", async () => {
    await boot("/?feed=F&a=X");
    for (const id of ["palette", "shortcuts", "add-feed", "search", "sources"] as const) {
      await store.nav.openOverlay(id);
      expect(nav().overlay).toBe(id);
      await systemBack();
      expect(nav().overlay).toBeNull();
      expect(history.here()).toBe("/?feed=F&a=X"); // the reader is still open
    }
  });

  it("overlays never nest: opening another swaps the entry", async () => {
    await boot("/");
    await store.nav.openOverlay("palette");
    const depth = history.length;
    await store.nav.openOverlay("add-feed");
    expect(nav().overlay).toBe("add-feed");
    expect(history.length).toBe(depth);
    await systemBack();
    expect(nav().overlay).toBeNull();
    expect(history.here()).toBe("/");
    expect(nav().index).toBe(0);
  });

  it("closeOverlay(id) only closes that overlay; toggle opens and closes", async () => {
    await boot("/");
    await store.nav.openOverlay("search");
    await store.nav.closeOverlay("palette");
    expect(nav().overlay).toBe("search");
    await store.nav.toggleOverlay("palette");
    expect(nav().overlay).toBe("palette");
    await store.nav.toggleOverlay("palette");
    await settle();
    expect(nav().overlay).toBeNull();
    expect(history.here()).toBe("/");
    expect(nav().index).toBe(0);
  });

  it("fine-pointer wide overlays push no entry (spec row 8)", async () => {
    await boot("/", "expanded");
    const depth = history.length;
    await store.nav.openOverlay("palette");
    expect(history.length).toBe(depth);
    await store.nav.closeOverlay();
    expect(nav().overlay).toBeNull();
  });
});
