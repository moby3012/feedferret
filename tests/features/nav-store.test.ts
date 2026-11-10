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

/** Reload: the history (entries + states) survives, the module state does not. */
async function reload() {
  stop();
  vi.resetModules();
  store = await import("../../features/reader/nav/store");
  stop = store.bootNav(() => {});
  await settle();
}

/** Crosses breakpoints back to back without letting the traversal in between finish. */
async function jitter(...sizes: ("compact" | "medium" | "expanded")[]) {
  for (const to of sizes) {
    layout.current = to;
    layout.listeners.forEach((l) => l());
  }
  await settle(60);
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

  it("Back before Next commits the seeding restore: its late write keeps the parent entry's URL", async () => {
    await boot("/?a=X", "expanded");
    expect(history.backStack()).toEqual(["/", "/?a=X"]);
    const stale = history.current.url.href;
    await systemBack();
    expect(history.here()).toBe("/");
    // Next's HistoryUpdater committing the restore of our push only now: it
    // preserves the custom state (our `ff`) and writes the restore's URL.
    const routerHistory = (globalThis as unknown as { window: { history: History } }).window.history;
    routerHistory.replaceState({ ...(history.state as object), __NA: true, __PRIVATE_NEXTJS_INTERNALS_TREE: {} }, "", stale);
    expect(history.here()).toBe("/");
    expect((history.state as { ff: unknown }).ff).toEqual({ i: 0, k: "root" });
    expect(here().articleId).toBeNull();
    // Next's router does not follow in-shell entries: its own later writes of
    // the shell path (refresh / server-action commit) carry a stale URL and no
    // custom state — the entry keeps its URL and `ff`.
    routerHistory.replaceState({ __NA: true }, "", "/?tab=search&q=x");
    expect(history.here()).toBe("/");
    expect((history.state as { ff: unknown }).ff).toEqual({ i: 0, k: "root" });
    // A router navigation to another path passes unchanged.
    routerHistory.replaceState({ __NA: true }, "", "/login");
    expect(history.here()).toBe("/login");
  });

  it("every write carries Next's keys (its history patch then skips the router sync: no late echo write)", async () => {
    layout.current = "expanded";
    history = new MemoryHistory("/?a=X");
    const tree = { tree: ["", {}], renderedSearch: "?a=X" };
    history.current.state = { __NA: true, __PRIVATE_NEXTJS_INTERNALS_TREE: tree };
    uninstall = installMemoryWindow(history);
    vi.resetModules();
    store = await import("../../features/reader/nav/store");
    stop = store.bootNav(() => {});
    await settle();
    expect(history.backStack()).toEqual(["/", "/?a=X"]);
    await store.nav.stepArticle("Y");
    for (const entry of history.entries.slice(1)) expect(entry.state).toMatchObject({ __NA: true, __PRIVATE_NEXTJS_INTERNALS_TREE: tree });
  });

  it("a traversal between shell entries is not passed on to Next's popstate listener", async () => {
    await boot("/?a=X", "expanded");
    const routerPop = vi.fn();
    (globalThis as unknown as { window: Window }).window.addEventListener("popstate", routerPop);
    await systemBack(); // article → seeded list: ours alone
    expect(history.here()).toBe("/");
    expect(routerPop).not.toHaveBeenCalled();
    await systemBack(); // leaving the app: not a shell entry
    expect(history.exited).toBe(true);
    expect(routerPop).toHaveBeenCalledTimes(1);
  });

  it("<html data-nav-ready> is set once the stack is seeded and cleared on unmount", async () => {
    await boot("/?feed=F&a=X");
    const dataset = (globalThis as unknown as { document: { documentElement: { dataset: Record<string, string> } } }).document.documentElement.dataset;
    expect(dataset.navReady).toBe("true");
    stop();
    expect(dataset.navReady).toBeUndefined();
    stop = () => {};
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

describe("resize jitter during a stack rewrite", () => {
  it("compact → wide → compact mid-traversal keeps the Feeds root (Back exits after three steps)", async () => {
    await boot("/?feed=F&a=X");
    await jitter("expanded", "compact");
    expect(history.backStack()).toEqual(["/?tab=feeds", "/?feed=F", "/?feed=F&a=X"]);
    expect(nav().index).toBe(2);
    expect(here().articleId).toBe("X");
    await systemBack();
    expect(history.here()).toBe("/?feed=F");
    await systemBack();
    expect(history.here()).toBe("/?tab=feeds");
    expect(history.exited).toBe(false);
    await systemBack();
    expect(history.exited).toBe(true);
  });

  it("wide → compact → wide mid-traversal ends on the wide chain", async () => {
    await boot("/?feed=F", "expanded");
    await store.nav.openArticle("X");
    await jitter("compact", "expanded");
    expect(history.backStack()).toEqual(["/?feed=F", "/?feed=F&a=X"]);
    expect(nav().index).toBe(1);
    await systemBack();
    expect(history.here()).toBe("/?feed=F");
    await systemBack();
    expect(history.exited).toBe(true);
  });

  it("many crossings in a row settle on the last layout, the entry kinds match it", async () => {
    await boot("/?feed=F&a=X");
    await jitter("expanded", "compact", "medium", "compact", "expanded", "compact");
    expect(history.backStack()).toEqual(["/?tab=feeds", "/?feed=F", "/?feed=F&a=X"]);
    expect(history.entries.slice(1, history.index + 1).map((e) => (e.state as { ff: { k: string } }).ff.k)).toEqual([
      "root",
      "scope",
      "article",
    ]);
    // A later single crossing still reconciles (nothing is left stuck as "queued").
    await resize("expanded");
    expect(history.backStack()).toEqual(["/?feed=F", "/?feed=F&a=X"]);
  });
});

describe("reload", () => {
  it("on an overlay's transient entry: boots on the entry beneath it, Back leaves the article", async () => {
    await boot("/?feed=F&a=X");
    await store.nav.openOverlay("palette");
    expect(history.backStack()).toEqual(["/?tab=feeds", "/?feed=F", "/?feed=F&a=X", "/?feed=F&a=X"]);
    await reload();
    expect(nav().overlay).toBeNull();
    expect(nav().index).toBe(2);
    expect(history.backStack()).toEqual(["/?tab=feeds", "/?feed=F", "/?feed=F&a=X"]);
    await systemBack();
    expect(history.here()).toBe("/?feed=F");
    expect(here().articleId).toBeNull();
  });

  it("on an overlay entry over a root: boots on the root, Back leaves the app", async () => {
    await boot("/");
    await store.nav.openOverlay("search");
    await store.nav.openOverlay("palette"); // swapped, still one transient entry
    await reload();
    expect(nav().overlay).toBeNull();
    expect(nav().index).toBe(0);
    expect(history.backStack()).toEqual(["/"]);
    await systemBack();
    expect(history.exited).toBe(true);
  });

  it("on a normal entry: keeps the stack as it is", async () => {
    await boot("/?feed=F&a=X");
    await reload();
    expect(history.backStack()).toEqual(["/?tab=feeds", "/?feed=F", "/?feed=F&a=X"]);
    expect(nav().index).toBe(2);
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
