// Deterministic stand-in for the AI provider in the K3 tests (no network).
// Mirrors the `tagging` behaviour of the fake provider in .pm/spec-ai-briefing.md §6:
//   tags      = first 2 capitalized words of the title
//   entities  = all-caps / digit-bearing tokens of the title
//   sponsored = body contains "Anzeige"
//   clickbait = title ends with "?!"      cleanTitle = title minus the trailing "?!"
// Use as the `runAiPrompt` mock: vi.fn(fakeTaggingProvider).

export const fakeTaggingCalls: string[] = [];

function unescape(text: string): string {
  return text.replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&");
}

export async function fakeTaggingProvider(prompt: string): Promise<string> {
  fakeTaggingCalls.push(prompt);
  if (!prompt.includes("<!-- ff:task=tagging v2 -->")) return "[]";
  const title = unescape(/<title>([\s\S]*?)<\/title>/.exec(prompt)?.[1] ?? "");
  const body = unescape(/<article>\n?([\s\S]*?)\n?<\/article>/.exec(prompt)?.[1] ?? "");

  const words = title.split(/\s+/).filter(Boolean);
  const tags = words.filter((w) => /^[A-ZÄÖÜ][a-zäöüß]+$/.test(w)).slice(0, 2);
  const entities = words.map((w) => w.replace(/[^\p{L}\p{N}-]/gu, "")).filter((w) => /^[A-Z]{2,6}$/.test(w) || /\d/.test(w));
  const clickbait = /\?!\s*$/.test(title);
  return JSON.stringify({
    tags,
    entities,
    sponsored: body.includes("Anzeige"),
    clickbait,
    cleanTitle: clickbait ? title.replace(/\s*\?!\s*$/, "") : null,
  });
}
