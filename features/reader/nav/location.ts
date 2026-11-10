// URL schema of the reader shell (.pm/spec-shell-design.md §1.3). Isomorphic
// and pure: the server page, the nav store and the unit tests share it.
//
//   tab   feeds | search            only on a tab root without scope
//   v     later | starred | recent | spoiler
//   feed · cat · label · ss  <id>   mutually exclusive with each other and v
//   show  all                       include read items (all/feed/cat/label/ss only)
//   q     <text>                    ad-hoc search
//   a     <articleId>               open article
//
// Old links (manifest shortcuts, notifications, push) keep working through
// aliases that the shell rewrites with replaceState at boot.
import { MAX_ID_LENGTH, MAX_QUERY_LENGTH, listKeyOf, scopeParams, showApplies, type ListKey, type Scope, type Show, type Sort } from "@/features/articles/scope";

export type { Scope, Show, Sort } from "@/features/articles/scope";

export type TabId = "new" | "saved" | "feeds" | "search";
export const TAB_IDS: readonly TabId[] = ["new", "saved", "feeds", "search"];

/** A location inside the shell. `scope: null` = Feeds/Suche tab root. */
export interface Loc {
  tab: TabId;
  scope: Scope | null;
  show: Show;
  articleId: string | null;
}

/** Layout family that decides the history depth of a location (compact has a Feeds root level). */
export type NavLayout = "compact" | "wide";

export const TAB_ROOTS: Readonly<Record<TabId, Loc>> = {
  new: { tab: "new", scope: { kind: "all" }, show: "unread", articleId: null },
  saved: { tab: "saved", scope: { kind: "later" }, show: "unread", articleId: null },
  feeds: { tab: "feeds", scope: null, show: "unread", articleId: null },
  search: { tab: "search", scope: null, show: "unread", articleId: null },
};

/** Tab a scope belongs to (`tabOf` in the spec). */
export function tabOfScope(scope: Scope | null, rootTab: TabId = "new"): TabId {
  if (!scope) return rootTab === "feeds" || rootTab === "search" ? rootTab : "new";
  switch (scope.kind) {
    case "query":
      return "search";
    case "later":
    case "starred":
      return "saved";
    case "all":
      return "new";
    default:
      return "feeds";
  }
}

export function tabOf(loc: Loc): TabId {
  return loc.tab;
}

/** Builds a canonical Loc for a scope (show is dropped where it does not apply). */
export function locOf(scope: Scope | null, show: Show = "unread", articleId: string | null = null, rootTab: TabId = "new"): Loc {
  const canonicalShow: Show = scope && showApplies(scope) && show === "all" ? "all" : "unread";
  return { tab: tabOfScope(scope, rootTab), scope, show: canonicalShow, articleId };
}

const SMART = new Set(["later", "starred", "recent", "spoiler"]);
const VIEW_ALIASES: Record<string, Scope | "show-all"> = {
  new: { kind: "all" },
  all: "show-all",
  readlater: { kind: "later" },
  starred: { kind: "starred" },
};

function validId(value: string | null): string | null {
  if (!value) return null;
  return value.length <= MAX_ID_LENGTH ? value : null;
}

/**
 * Parses a query string into a Loc. Never throws: invalid or conflicting
 * params are dropped (first scope param in canonical order wins), aliases
 * (`view=`, `article=`) are understood.
 */
export function parseLoc(search: string): Loc {
  const sp = new URLSearchParams(search.startsWith("?") ? search.slice(1) : search);
  let scope: Scope | null = null;
  let show: Show = sp.get("show") === "all" ? "all" : "unread";

  const v = sp.get("v");
  const q = sp.get("q")?.trim();
  if (v && SMART.has(v)) scope = { kind: v as "later" | "starred" | "recent" | "spoiler" };
  else if (validId(sp.get("feed"))) scope = { kind: "feed", id: sp.get("feed")! };
  else if (validId(sp.get("cat"))) scope = { kind: "category", id: sp.get("cat")! };
  else if (validId(sp.get("label"))) scope = { kind: "label", id: sp.get("label")! };
  else if (validId(sp.get("ss"))) scope = { kind: "saved-search", id: sp.get("ss")! };
  else if (q) scope = { kind: "query", q: q.slice(0, MAX_QUERY_LENGTH) };

  const view = sp.get("view");
  if (!scope && view && view in VIEW_ALIASES) {
    const alias = VIEW_ALIASES[view];
    if (alias === "show-all") show = "all";
    else scope = alias;
  }

  const rawTab = sp.get("tab");
  if (!scope) {
    if (rawTab === "feeds" || rawTab === "search") return { tab: rawTab, scope: null, show: "unread", articleId: null };
    scope = { kind: "all" };
  }
  const articleId = validId(sp.get("a")) ?? validId(sp.get("article"));
  return locOf(scope, show, articleId);
}

/** Canonical URL (path `/`) of a Loc; params in the order of §1.3. */
export function formatLoc(loc: Loc): string {
  const params: [string, string][] = [];
  if (!loc.scope) {
    if (loc.tab === "feeds" || loc.tab === "search") params.push(["tab", loc.tab]);
  } else {
    params.push(...scopeParams(loc.scope, loc.show));
  }
  if (loc.articleId) params.push(["a", loc.articleId]);
  const qs = new URLSearchParams(params).toString();
  return qs ? `/?${qs}` : "/";
}

export function sameLoc(a: Loc, b: Loc): boolean {
  return formatLoc(a) === formatLoc(b);
}

/** The level a Back from this location leads to; null on a tab root. */
export function parentOf(loc: Loc, layout: NavLayout = "compact"): Loc | null {
  if (loc.articleId) return { ...loc, articleId: null };
  if (layout === "compact" && loc.tab === "feeds" && loc.scope) return TAB_ROOTS.feeds;
  return null;
}

/** Root-first chain of entries that lead to `loc` (stack seeding, tab reset). */
export function stackOf(loc: Loc, layout: NavLayout = "compact"): Loc[] {
  const chain: Loc[] = [loc];
  let parent = parentOf(loc, layout);
  while (parent && chain.length < 4) {
    chain.unshift(parent);
    parent = parentOf(parent, layout);
  }
  return chain;
}

/** Entry kind written to `history.state.ff.k` for a location. */
export function entryKindOf(loc: Loc, layout: NavLayout = "compact"): "root" | "scope" | "article" {
  if (loc.articleId) return "article";
  return parentOf(loc, layout) ? "scope" : "root";
}

/** The list a location shows (null on Feeds/Suche roots). */
export function listKeyOfLoc(loc: Loc, sort: Sort): ListKey | null {
  return loc.scope ? listKeyOf(loc.scope, loc.show, sort) : null;
}

/** One-shot params a share target / deep link carries (acted on once, then stripped). */
export interface LocIntents {
  addFeed: boolean;
  /** Share-target URL that pre-fills the Add-Feed dialog. */
  sharedUrl: string | null;
}

const CONSUMED = ["addFeed", "sharedUrl", "sharedText", "sharedTitle"];
const ALIASES = ["view", "article"];

/**
 * Splits a raw query string into its canonical location, the one-shot
 * intents it carries and whether the URL has to be rewritten.
 */
export function normalizeSearch(search: string): { loc: Loc; href: string; intents: LocIntents; changed: boolean } {
  const sp = new URLSearchParams(search.startsWith("?") ? search.slice(1) : search);
  const sharedUrl = sp.get("sharedUrl")?.trim() || null;
  const sharedText = sp.get("sharedText")?.trim() || null;
  const candidate = sharedUrl || (sharedText && /^https?:\/\//i.test(sharedText) ? sharedText : null);
  const intents: LocIntents = { addFeed: sp.get("addFeed") === "1", sharedUrl: candidate };
  const loc = parseLoc(search);
  const href = formatLoc(loc);
  const original = sp.toString();
  const hadExtras = CONSUMED.some((k) => sp.has(k)) || ALIASES.some((k) => sp.has(k));
  const changed = hadExtras || (original ? `/?${original}` : "/") !== href;
  return { loc, href, intents, changed };
}
