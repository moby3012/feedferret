// Isomorphic list-scope helpers shared by the /api/app/articles route (parse)
// and the client (format + query keys). See .pm/spec-shell-design.md §1.3/§2.

export type Scope =
  | { kind: "all" }
  | { kind: "later" }
  | { kind: "starred" }
  | { kind: "recent" }
  | { kind: "spoiler" }
  | { kind: "feed"; id: string }
  | { kind: "category"; id: string }
  | { kind: "label"; id: string }
  | { kind: "saved-search"; id: string }
  | { kind: "query"; q: string };

export type Show = "unread" | "all";
export type Sort = "new" | "old";

export interface ListKey {
  /** Canonical list URL (`/?feed=…&show=all`), without the open article. */
  id: string;
  scopeKey: string;
  show: Show;
  sort: Sort;
}

const SMART_VIEWS = { later: "later", starred: "starred", recent: "recent", spoiler: "spoiler" } as const;
type SmartView = keyof typeof SMART_VIEWS;

/** `show` is ignored for smart views and ad-hoc search (they are never server-filtered to unread). */
export function showApplies(scope: Scope): boolean {
  return scope.kind === "all" || scope.kind === "feed" || scope.kind === "category" || scope.kind === "label" || scope.kind === "saved-search";
}

/**
 * The list folds story clusters into one card per story (`groupStories`):
 * everything but the personal smart views. The "↑ N neu" probe counts
 * stories for these, articles for the rest.
 */
export function groupsStories(scope: Scope): boolean {
  return scope.kind !== "later" && scope.kind !== "starred" && scope.kind !== "recent";
}

export function scopeKey(scope: Scope): string {
  switch (scope.kind) {
    case "all":
      return "all";
    case "later":
    case "starred":
    case "recent":
    case "spoiler":
      return `v:${scope.kind}`;
    case "feed":
      return `feed:${scope.id}`;
    case "category":
      return `cat:${scope.id}`;
    case "label":
      return `label:${scope.id}`;
    case "saved-search":
      return `ss:${scope.id}`;
    case "query":
      return `q:${scope.q}`;
  }
}

/** URL params of a scope, in canonical order (§1.3): v · feed · cat · label · ss · show · q. */
export function scopeParams(scope: Scope, show: Show): [string, string][] {
  const out: [string, string][] = [];
  switch (scope.kind) {
    case "later":
    case "starred":
    case "recent":
    case "spoiler":
      out.push(["v", scope.kind]);
      break;
    case "feed":
      out.push(["feed", scope.id]);
      break;
    case "category":
      out.push(["cat", scope.id]);
      break;
    case "label":
      out.push(["label", scope.id]);
      break;
    case "saved-search":
      out.push(["ss", scope.id]);
      break;
  }
  if (showApplies(scope) && show === "all") out.push(["show", "all"]);
  if (scope.kind === "query") out.push(["q", scope.q]);
  return out;
}

export function listKeyOf(scope: Scope, show: Show, sort: Sort): ListKey {
  const effectiveShow: Show = showApplies(scope) ? show : "all";
  const qs = new URLSearchParams(scopeParams(scope, effectiveShow)).toString();
  return { id: qs ? `/?${qs}` : "/", scopeKey: scopeKey(scope), show: effectiveShow, sort };
}

export const MAX_ID_LENGTH = 128;
export const MAX_QUERY_LENGTH = 1000;

export type ParsedListParams =
  | { ok: true; scope: Scope; show: Show; sort: Sort }
  | { ok: false; error: string };

/** Parses `?v|feed|cat|label|ss|q` (mutually exclusive) plus `show` and `sort`. */
export function parseListParams(sp: URLSearchParams): ParsedListParams {
  const present = ["v", "feed", "cat", "label", "ss", "q"].filter((k) => sp.get(k) !== null && sp.get(k) !== "");
  if (present.length > 1) return { ok: false, error: `Scope parameters are mutually exclusive: ${present.join(", ")}` };

  let scope: Scope = { kind: "all" };
  const key = present[0];
  if (key) {
    const value = sp.get(key)!;
    if (key === "q") {
      const q = value.trim();
      if (q.length > MAX_QUERY_LENGTH) return { ok: false, error: "Search query too long" };
      scope = q ? { kind: "query", q } : { kind: "all" };
    } else if (value.length > MAX_ID_LENGTH) {
      return { ok: false, error: `Invalid ${key}` };
    } else if (key === "v") {
      if (!(value in SMART_VIEWS)) return { ok: false, error: "Invalid v" };
      scope = { kind: SMART_VIEWS[value as SmartView] };
    } else if (key === "feed") scope = { kind: "feed", id: value };
    else if (key === "cat") scope = { kind: "category", id: value };
    else if (key === "label") scope = { kind: "label", id: value };
    else scope = { kind: "saved-search", id: value };
  }

  const showRaw = sp.get("show");
  if (showRaw !== null && showRaw !== "all" && showRaw !== "unread") return { ok: false, error: "Invalid show" };
  const sortRaw = sp.get("sort");
  if (sortRaw !== null && sortRaw !== "new" && sortRaw !== "old") return { ok: false, error: "Invalid sort" };
  const show: Show = showRaw === "all" || !showApplies(scope) ? "all" : "unread";
  return { ok: true, scope, show, sort: sortRaw === "old" ? "old" : "new" };
}
