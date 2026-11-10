// K2 "catch me up" briefing — wire types shared by server and client
// (.pm/spec-ai-briefing.md §K2.2). Pure types, no runtime imports.

export type BriefingScope = { kind: "new" } | { kind: "category"; id: string } | { kind: "label"; id: string };

export interface Citation {
  articleId: string;
  title: string;
  feedName: string;
}

export interface BriefingItem {
  text: string;
  citations: Citation[];
}

export type BriefingSection = "what" | "why" | "brief";

export interface BriefingContent {
  mode: "ai" | "headlines";
  what: BriefingItem[];
  why: BriefingItem[];
  brief: BriefingItem[];
  /** Model lines / citations removed by the validator. */
  dropped: number;
  storyCount: number;
  window: { start: string; end: string };
}

export type FallbackReason = "no_ai" | "budget" | "invalid_output" | "provider_error" | "too_few" | "rate_limited";

export type AiState = "ready" | "off" | "budget" | "error";

export interface BriefingResponse {
  briefing: BriefingContent | null;
  briefingId: string | null;
  stale: { newStories: number } | null;
  ai: AiState;
  generatedAt: string | null;
  seen: boolean;
  /** Why `briefing` is a headline digest (null for AI content). */
  fallbackReason: FallbackReason | null;
  /** Unread candidates in the window (0 → the card hides itself). */
  totalUnread: number;
  /** Generate without a tap when the card opens (local provider + briefingAuto). */
  auto: boolean;
  /** Footnote "KI · {model}" (null without AI). */
  model: string | null;
  /** Output language of the briefing (speech synthesis). */
  lang: string;
}

export type BriefingErrorCode = "rate_limited" | "provider_auth" | "provider_down" | "timeout" | "invalid_output";

export type BriefingEvent =
  | { type: "meta"; briefingId: string | null; storyCount: number; cached: boolean; stale?: { newStories: number } | null; window?: { start: string; end: string } }
  | { type: "item"; section: BriefingSection; item: BriefingItem }
  | { type: "dropped"; count: number }
  | { type: "done"; status: "ok" | "partial"; usage: { in: number; out: number }; briefingId: string | null; generatedAt: string | null }
  | { type: "fallback"; reason: FallbackReason; briefing: BriefingContent }
  | { type: "error"; code: BriefingErrorCode };

export const SCOPE_NEW = "new";

/** Wire scope key ↔ scope. Unknown shapes → null (400). */
export function parseBriefingScope(raw: string | null | undefined): BriefingScope | null {
  if (!raw || raw === SCOPE_NEW) return { kind: "new" };
  const m = /^(cat|label):([\w-]{1,128})$/.exec(raw);
  if (!m) return null;
  return m[1] === "cat" ? { kind: "category", id: m[2] } : { kind: "label", id: m[2] };
}

export function briefingScopeKey(scope: BriefingScope): string {
  return scope.kind === "new" ? SCOPE_NEW : scope.kind === "category" ? `cat:${scope.id}` : `label:${scope.id}`;
}
