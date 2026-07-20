// Resolves a feed's effective full-text extraction mode.
//
// `Feed.fullTextMode` ("off" | "auto" | "selector" | "ai") is the new,
// explicit control. It defaults to "off" for every existing row, though, so
// it can't be trusted on its own — a feed created before this field existed
// may still have the legacy `autoFetchFullText` boolean set to `true`, and
// those feeds must keep getting full-text via the existing selector/heuristic
// path.
//
// "ai" (M6) is like "auto" but additionally opts this specific feed into the
// per-article BYOK AI-extraction fallback (lib/ai-extraction.ts) when the
// deterministic engine tiers all come up empty — opt-in per feed since it
// spends the user's own AI tokens per article.
//
// Resolution order:
//   1. `fullTextMode` set to "auto", "selector", or "ai" wins outright.
//   2. Otherwise fall back to the legacy boolean: `autoFetchFullText: true`
//      means "selector" (the only behavior that flag ever gated).
//   3. Otherwise "off".
export type FullTextMode = "off" | "auto" | "selector" | "ai";

export function resolveFullTextMode(feed: {
  fullTextMode?: string | null;
  autoFetchFullText?: boolean | null;
}): FullTextMode {
  if (feed.fullTextMode === "auto" || feed.fullTextMode === "selector" || feed.fullTextMode === "ai") {
    return feed.fullTextMode;
  }
  if (feed.autoFetchFullText) return "selector";
  return "off";
}

// Detects a feed that deliberately ships only a short teaser (e.g. WordPress's
// "Summary" feed mode, common on sites that want readers to click through) —
// a manual full-text fetch landing dramatically more content than the feed
// itself provided is a much more reliable signal than guessing from
// link/teaser text patterns, and it works retroactively for feeds added long
// before this existed, at exactly the moment the user notices (their own
// manual fetch).
export function looksLikeTruncatedFeed(existingPlainLength: number, newPlainLength: number): boolean {
  return existingPlainLength < 800 && newPlainLength >= existingPlainLength * 2.5 && newPlainLength >= 1200;
}
