import { describe, expect, it } from "vitest";
import {
  TAB_ROOTS,
  entryKindOf,
  formatLoc,
  listKeyOfLoc,
  locOf,
  normalizeSearch,
  parentOf,
  parseLoc,
  stackOf,
  tabOfScope,
  type Loc,
} from "../../features/reader/nav/location";
import { categoryKey, markViewScopeOf, scopeFromSidebarKey, sidebarSelectionOf } from "../../features/reader/nav/sidebar-keys";

const CANONICAL = [
  "/",
  "/?show=all",
  "/?a=art1",
  "/?tab=feeds",
  "/?tab=search",
  "/?tab=feeds&a=n1",
  "/?tab=search&a=n2",
  "/?v=later",
  "/?v=starred",
  "/?v=recent",
  "/?v=spoiler&a=x",
  "/?feed=f1",
  "/?feed=f1&show=all&a=art+2",
  "/?cat=c1",
  "/?label=l1&show=all",
  "/?ss=s1",
  "/?q=rust+async",
  "/?q=rust&a=a9",
];

describe("parseLoc / formatLoc", () => {
  it.each(CANONICAL)("round-trips the canonical URL %s", (href) => {
    const loc = parseLoc(href.slice(2));
    expect(formatLoc(loc)).toBe(href);
    expect(parseLoc(formatLoc(loc).slice(2))).toEqual(loc);
  });

  it("orders params canonically (tab · v · feed/cat/label/ss · show · q · a)", () => {
    expect(formatLoc(parseLoc("a=1&show=all&feed=f"))).toBe("/?feed=f&show=all&a=1");
  });

  it("drops `show` where it does not apply (smart views, search)", () => {
    expect(formatLoc(parseLoc("v=later&show=all"))).toBe("/?v=later");
    expect(formatLoc(parseLoc("q=x&show=all"))).toBe("/?q=x");
  });

  it("is tolerant: conflicting scopes keep the first in canonical order, junk is ignored", () => {
    expect(parseLoc("feed=f&cat=c").scope).toEqual({ kind: "feed", id: "f" });
    expect(parseLoc("v=bogus").scope).toEqual({ kind: "all" });
    expect(parseLoc("feed=" + "x".repeat(200)).scope).toEqual({ kind: "all" });
    expect(parseLoc("tab=nope")).toEqual(TAB_ROOTS.new);
    expect(parseLoc("q=%20%20").scope).toEqual({ kind: "all" });
  });

  it("tab=… only describes a scope-less tab root", () => {
    expect(parseLoc("tab=feeds&feed=f").scope).toEqual({ kind: "feed", id: "f" });
    expect(formatLoc({ ...TAB_ROOTS.feeds, articleId: null })).toBe("/?tab=feeds");
  });
});

describe("aliases and consumed params", () => {
  it.each([
    ["view=new", "/"],
    ["view=all", "/?show=all"],
    ["view=readlater", "/?v=later"],
    ["view=starred", "/?v=starred"],
    ["article=a1", "/?a=a1"],
    ["view=readlater&article=a1", "/?v=later&a=a1"],
  ])("%s → %s", (search, href) => {
    const n = normalizeSearch(`?${search}`);
    expect(n.href).toBe(href);
    expect(n.changed).toBe(true);
  });

  it("canonical URLs are left alone", () => {
    expect(normalizeSearch("?feed=f&a=1").changed).toBe(false);
    expect(normalizeSearch("").changed).toBe(false);
  });

  it("addFeed and the share target are one-shot intents, stripped from the URL", () => {
    expect(normalizeSearch("?addFeed=1")).toMatchObject({ href: "/", changed: true, intents: { addFeed: true, sharedUrl: null } });
    expect(normalizeSearch("?sharedUrl=https%3A%2F%2Fa.example").intents.sharedUrl).toBe("https://a.example");
    expect(normalizeSearch("?sharedText=%20https%3A%2F%2Fb.example%20&sharedTitle=B").intents.sharedUrl).toBe("https://b.example");
    expect(normalizeSearch("?sharedText=just%20words").intents.sharedUrl).toBeNull();
  });
});

describe("tabOf", () => {
  it.each([
    [{ kind: "all" }, "new"],
    [{ kind: "later" }, "saved"],
    [{ kind: "starred" }, "saved"],
    [{ kind: "recent" }, "feeds"],
    [{ kind: "spoiler" }, "feeds"],
    [{ kind: "feed", id: "f" }, "feeds"],
    [{ kind: "category", id: "c" }, "feeds"],
    [{ kind: "label", id: "l" }, "saved"],
    [{ kind: "saved-search", id: "s" }, "feeds"],
    [{ kind: "query", q: "x" }, "search"],
  ] as const)("%j → %s", (scope, tab) => {
    expect(tabOfScope(scope)).toBe(tab);
    expect(parseLoc(formatLoc(locOf(scope)).slice(2)).tab).toBe(tab);
  });

  it("tab roots", () => {
    expect(parseLoc("").tab).toBe("new");
    expect(parseLoc("v=later").tab).toBe("saved");
    expect(parseLoc("tab=feeds").tab).toBe("feeds");
    expect(parseLoc("tab=search").tab).toBe("search");
  });
});

describe("tab roots keep the open article (reload / back / forward)", () => {
  it("parses `a` on a scope-less tab root", () => {
    expect(parseLoc("tab=feeds&a=X")).toEqual({ tab: "feeds", scope: null, show: "unread", articleId: "X" });
    expect(parseLoc("tab=search&article=Y").articleId).toBe("Y");
  });
  it("normalizeSearch leaves the canonical root+article URL unchanged", () => {
    expect(normalizeSearch("?tab=feeds&a=X")).toMatchObject({ href: "/?tab=feeds&a=X", changed: false });
    expect(normalizeSearch("?tab=feeds&article=X")).toMatchObject({ href: "/?tab=feeds&a=X", changed: true });
  });
  it("its parent is the root, its stack root → article", () => {
    const loc = parseLoc("tab=feeds&a=X");
    expect(formatLoc(parentOf(loc, "compact")!)).toBe("/?tab=feeds");
    expect(stackOf(loc, "compact").map(formatLoc)).toEqual(["/?tab=feeds", "/?tab=feeds&a=X"]);
    expect(entryKindOf(loc)).toBe("article");
  });
});

describe("parentOf / stackOf", () => {
  const feedArticle = parseLoc("feed=f&a=1");
  it("article → its list (every layout)", () => {
    expect(formatLoc(parentOf(feedArticle, "wide")!)).toBe("/?feed=f");
    expect(formatLoc(parentOf(parseLoc("a=1"))!)).toBe("/");
  });
  it("compact: a Feeds-tab scope sits on the Feeds root; wide has no such level", () => {
    expect(formatLoc(parentOf(parseLoc("feed=f"), "compact")!)).toBe("/?tab=feeds");
    expect(parentOf(parseLoc("feed=f"), "wide")).toBeNull();
    expect(parentOf(parseLoc("v=later"), "compact")).toBeNull();
    expect(parentOf(TAB_ROOTS.feeds)).toBeNull();
    expect(parentOf(TAB_ROOTS.new)).toBeNull();
  });
  it("stack seeding chain for cold deep links", () => {
    expect(stackOf(feedArticle, "compact").map(formatLoc)).toEqual(["/?tab=feeds", "/?feed=f", "/?feed=f&a=1"]);
    expect(stackOf(feedArticle, "wide").map(formatLoc)).toEqual(["/?feed=f", "/?feed=f&a=1"]);
    expect(stackOf(parseLoc("a=9")).map(formatLoc)).toEqual(["/", "/?a=9"]);
    expect(stackOf(parseLoc("v=starred")).map(formatLoc)).toEqual(["/?v=starred"]);
    expect(stackOf(feedArticle, "compact").map((l) => entryKindOf(l, "compact"))).toEqual(["root", "scope", "article"]);
  });
});

describe("list keys", () => {
  it("lists are keyed without the open article", () => {
    const a: Loc = parseLoc("feed=f&a=1");
    const b: Loc = parseLoc("feed=f&a=2");
    expect(listKeyOfLoc(a, "new")).toEqual(listKeyOfLoc(b, "new"));
    expect(listKeyOfLoc(a, "new")!.id).toBe("/?feed=f");
    expect(listKeyOfLoc(TAB_ROOTS.feeds, "new")).toBeNull();
  });
});

describe("sidebar keys (categories by id)", () => {
  it("round-trips every scope the sidebar can select", () => {
    for (const scope of [
      { kind: "all" },
      { kind: "starred" },
      { kind: "later" },
      { kind: "spoiler" },
      { kind: "recent" },
      { kind: "label", id: "l" },
      { kind: "saved-search", id: "s" },
      { kind: "category", id: "c1" },
    ] as const) {
      expect(scopeFromSidebarKey(sidebarSelectionOf(scope).selectedCategory)).toEqual(scope);
    }
    expect(sidebarSelectionOf({ kind: "feed", id: "f" })).toEqual({ selectedFeed: "f", selectedCategory: "All" });
  });
  it("two same-named folders are two scopes", () => {
    expect(scopeFromSidebarKey(categoryKey("a"))).not.toEqual(scopeFromSidebarKey(categoryKey("b")));
    expect(markViewScopeOf({ kind: "category", id: "b" })).toMatchObject({ categoryId: "b" });
  });
});
