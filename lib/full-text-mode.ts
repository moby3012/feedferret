// Resolves a feed's effective full-text extraction mode.
//
// `Feed.fullTextMode` ("off" | "auto" | "selector") is the new, explicit
// control. It defaults to "off" for every existing row, though, so it can't
// be trusted on its own — a feed created before this field existed may still
// have the legacy `autoFetchFullText` boolean set to `true`, and those feeds
// must keep getting full-text via the existing selector/heuristic path.
//
// Resolution order:
//   1. `fullTextMode` set to "auto" or "selector" wins outright.
//   2. Otherwise fall back to the legacy boolean: `autoFetchFullText: true`
//      means "selector" (the only behavior that flag ever gated).
//   3. Otherwise "off".
export type FullTextMode = "off" | "auto" | "selector";

export function resolveFullTextMode(feed: {
  fullTextMode?: string | null;
  autoFetchFullText?: boolean | null;
}): FullTextMode {
  if (feed.fullTextMode === "auto" || feed.fullTextMode === "selector") return feed.fullTextMode;
  if (feed.autoFetchFullText) return "selector";
  return "off";
}
