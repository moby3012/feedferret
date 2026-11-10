// K2 no-AI tier (.pm/spec-ai-briefing.md §K2.7): a headline digest by story
// cluster. Pure, no I/O, never persisted — also used for every fallback reason.
import type { BriefingContent, BriefingItem, Citation } from "./types";
import type { BriefingInput, StoryUnit } from "./select";

export const FALLBACK_WHAT = 5;
export const FALLBACK_BRIEF = 8;

export function citationOf(unit: StoryUnit): Citation {
  return { articleId: unit.leadId, title: unit.title, feedName: unit.memberFeedNames[0] ?? unit.feedNames[0] ?? "" };
}

function item(unit: StoryUnit): BriefingItem {
  // Lead + up to 2 more sources of the story: one chip per source, so the
  // source count is visible without any generated text.
  const citations = unit.memberIds.slice(0, 3).map((id, i) => ({ articleId: id, title: unit.title, feedName: unit.memberFeedNames[i] ?? unit.feedNames[0] ?? "" }));
  return { text: unit.title, citations };
}

export function buildHeadlineDigest(input: BriefingInput): BriefingContent {
  const units = [...input.top, ...input.brief];
  return {
    mode: "headlines",
    what: units.slice(0, FALLBACK_WHAT).map((u) => item(u)),
    why: [],
    brief: units.slice(FALLBACK_WHAT, FALLBACK_WHAT + FALLBACK_BRIEF).map((u) => item(u)),
    dropped: 0,
    storyCount: input.totalStories,
    window: { start: input.windowStart.toISOString(), end: input.windowEnd.toISOString() },
  };
}
