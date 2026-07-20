// AI auto-tagging (feed-intelligence roadmap F8): asks the user's configured
// AI provider to propose a handful of short topical tags for an article,
// reusing the existing Label/ArticleLabel schema — so AI-proposed tags show
// up in exactly the same badges, dropdowns, and "Label:" sidebar filters as
// tags a user creates by hand, with no separate UI needed.

import { type AiConfig, runAiPrompt, stripHtml } from "./ai-summary";

const MAX_CONTENT_CHARS = 4_000;
const MAX_TAGS = 4;
const MAX_TAG_LENGTH = 40;
const MAX_EXISTING_LABELS_IN_PROMPT = 40;

export function buildTaggingPrompt(content: string, existingLabels: string[] = []): string {
  const plain = stripHtml(content).slice(0, MAX_CONTENT_CHARS);
  const existingHint = existingLabels.length
    ? ` Prefer reusing one of these existing tags where it genuinely fits: ${existingLabels
        .slice(0, MAX_EXISTING_LABELS_IN_PROMPT)
        .join(", ")}. Only propose a new tag if none of them fit.`
    : "";

  return `Suggest up to ${MAX_TAGS} short topical tags (1-3 words each) for the following article, in the article's own language. Tags should be broad topics or categories (e.g. "Politics", "AI", "Climate"), not full sentences, and not the article's own title.${existingHint}

Respond with STRICT JSON only — a JSON array of strings, no prose, no markdown code fences, e.g. ["Politics","Elections"]. If nothing fits, respond with [].

Article:
${plain}`;
}

/**
 * Extracts a JSON array of strings from the model's raw text (tolerating
 * ```json fences and surrounding prose), then deduplicates (case-insensitive)
 * and bounds the result. Never throws — returns [] on any parse/shape failure.
 */
export function parseAiTags(rawText: string): string[] {
  if (typeof rawText !== "string") return [];

  const start = rawText.indexOf("[");
  const end = rawText.lastIndexOf("]");
  if (start === -1 || end === -1 || end < start) return [];

  let parsed: unknown;
  try {
    parsed = JSON.parse(rawText.slice(start, end + 1));
  } catch {
    return [];
  }
  if (!Array.isArray(parsed)) return [];

  const seen = new Set<string>();
  const tags: string[] = [];
  for (const item of parsed) {
    if (typeof item !== "string") continue;
    const trimmed = item.trim().slice(0, MAX_TAG_LENGTH);
    if (!trimmed) continue;
    const key = trimmed.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    tags.push(trimmed);
    if (tags.length >= MAX_TAGS) break;
  }
  return tags;
}

/** Proposes up to `MAX_TAGS` tag names for an article. Never throws — callers decide how to handle a rejected AI call. */
export async function generateTags(
  content: string,
  config: AiConfig,
  existingLabels: string[] = [],
): Promise<string[]> {
  const prompt = buildTaggingPrompt(content, existingLabels);
  const raw = await runAiPrompt(prompt, config, 200);
  return parseAiTags(raw);
}
