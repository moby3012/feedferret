// Per-article AI extraction fallback (feed-intelligence roadmap M6): when the
// deterministic extraction tiers (ftr-site-config, Defuddle, Readability,
// article-extractor, JSON-LD recovery — see lib/readability-extract.ts) all
// come up empty on a page whose structure trips up every one of them, and the
// user has opted a specific feed into "AI extraction" mode
// (`Feed.fullTextMode === "ai"`), ask their configured BYOK model to pull the
// clean article body directly from the page HTML. This runs as the final
// in-process fallback, before the (admin-configured, JS-rendering) render
// sidecar and hosted-API tiers.

import { type AiConfig, runAiPrompt } from "./ai-summary";
import { reduceHtmlForPrompt } from "./ai-feed-config";

const MIN_EXTRACTED_TEXT_LENGTH = 200;
const MAX_OUTPUT_TOKENS = 2000;

export type AiExtractionResult = { title: string | null; content: string };

export function buildExtractionPrompt(html: string, url: string): string {
  const snippet = reduceHtmlForPrompt(html);
  return `You are extracting the main article content from a web page at ${url}.

Find the article's title and its full body text, ignoring navigation, ads, comments, related-articles widgets, and other boilerplate. Preserve paragraph breaks, headings, and lists as Markdown. Do not summarize or shorten the article — reproduce its full text.

Respond with STRICT JSON only — no prose, no markdown code fences, no explanation outside the JSON object, in exactly this shape:
{"title":"Article title","content":"Full article body as Markdown..."}

If no article content can be found on this page, respond with exactly: {"title":null,"content":""}

Page HTML (structure preserved, scripts/styles/comments stripped, truncated):
${snippet}`;
}

/**
 * Extracts the JSON object from the model's raw text (tolerating ```json
 * fences and surrounding prose). Returns `null` on any parse/shape failure —
 * never throws.
 */
export function parseAiExtraction(rawText: string): AiExtractionResult | null {
  if (typeof rawText !== "string") return null;

  const start = rawText.indexOf("{");
  const end = rawText.lastIndexOf("}");
  if (start === -1 || end === -1 || end < start) return null;

  let parsed: unknown;
  try {
    parsed = JSON.parse(rawText.slice(start, end + 1));
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== "object") return null;

  const obj = parsed as Record<string, unknown>;
  if (typeof obj.content !== "string") return null;
  const title = typeof obj.title === "string" && obj.title.trim() ? obj.title.trim() : null;
  return { title, content: obj.content };
}

/** Rough plain-text length of a Markdown string, stripping the most common syntax markers. */
function plainTextLength(markdown: string): number {
  return markdown
    .replace(/[#*_`>[\]()!]/g, "")
    .replace(/\s+/g, " ")
    .trim().length;
}

/**
 * Asks the model to extract the article at `url` from its raw `html`.
 * Never throws — returns `null` on any provider error, parse failure, or a
 * result too thin to be a real article (mirrors every other tier in the
 * extraction waterfall).
 */
export async function extractArticleWithAi(
  html: string,
  url: string,
  config: AiConfig,
): Promise<AiExtractionResult | null> {
  try {
    const prompt = buildExtractionPrompt(html, url);
    const raw = await runAiPrompt(prompt, config, MAX_OUTPUT_TOKENS);
    const parsed = parseAiExtraction(raw);
    if (!parsed || plainTextLength(parsed.content) < MIN_EXTRACTED_TEXT_LENGTH) return null;
    return parsed;
  } catch {
    return null;
  }
}
