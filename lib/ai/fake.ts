// Deterministic fake AI provider (.pm/spec-ai-briefing.md §6) — the only
// provider CI ever talks to; no network. Behaviour is picked by `aiModel`
// (fake | fake-slow | fake-error | fake-auth | fake-garbage | fake-timeout) and
// the task by the `<!-- ff:task=… -->` marker every K prompt starts with.
//
// Gate: never available in a real deployment. It needs FEEDFERRET_FAKE_AI=1
// AND either a non-production NODE_ENV (vitest, `next dev`) or the disposable
// e2e harness database (a SQLite file inside a `.e2e/` directory — the e2e
// harness serves a production build, see playwright.config.ts). A production
// instance (Postgres, or SQLite under /app/data) can never satisfy it, even
// with the flag set by mistake.
import { AiProviderError } from "./errors";

export const FAKE_MODELS = ["fake", "fake-slow", "fake-error", "fake-auth", "fake-garbage", "fake-timeout"] as const;

export function isFakeAiEnabled(): boolean {
  if (process.env.FEEDFERRET_FAKE_AI !== "1") return false;
  if (process.env.NODE_ENV !== "production") return true;
  const provider = (process.env.DATABASE_PROVIDER || "sqlite").toLowerCase();
  const url = process.env.DATABASE_URL ?? "";
  return (provider === "sqlite" || provider === "file") && /^file:.*[\\/]\.e2e[\\/][\w.-]+\.db$/.test(url);
}

export function assertFakeAiEnabled() {
  if (!isFakeAiEnabled()) throw new Error("Unknown AI provider: fake");
}

const CHUNK = 7;

function taskOf(prompt: string): string {
  return /<!-- ff:task=([\w-]+)/.exec(prompt)?.[1] ?? "summary";
}

function storiesIn(block: string | undefined): { id: string; text: string }[] {
  if (!block) return [];
  const out: { id: string; text: string }[] = [];
  const re = /<story id="(s\d+)"[^>]*>([^<]*)<\/story>/g;
  for (let m = re.exec(block); m; m = re.exec(block)) out.push({ id: m[1], text: m[2] });
  return out;
}

const titleOf = (text: string) => text.split(" — ")[0].trim();

function fakeBriefing(prompt: string): string {
  const stories = storiesIn(/<stories>([\s\S]*?)<\/stories>/.exec(prompt)?.[1]);
  const brief = storiesIn(/<brief>([\s\S]*?)<\/brief>/.exec(prompt)?.[1]);
  const sourcesOf = (id: string) => Number(new RegExp(`<story id="${id}" sources="(\\d+)"`).exec(prompt)?.[1] ?? 1);
  const lines = ["## WHAT"];
  for (const s of stories.slice(0, 3)) lines.push(`- ${titleOf(s.text)} — ${sourcesOf(s.id)} Quellen. [[${s.id}]]`);
  lines.push("- Ungeprüfte Behauptung [[s99]]");
  lines.push("- Satz ohne Quelle");
  if (stories.some((s) => s.text.includes("IGNORE"))) lines.push("- <script>alert(1)</script> https://evil.example [[s1]]");
  lines.push("## WHY");
  if (stories.length) {
    const entity = titleOf(stories[0].text).split(/\s+/).find((w) => /^[A-ZÄÖÜ0-9]/.test(w)) ?? "Thema";
    lines.push(`- Relevant wegen ${entity}. [[${stories[0].id}]]${stories[1] ? ` [[${stories[1].id}]]` : ""}`);
  }
  lines.push("## BRIEF");
  for (const s of brief.slice(0, 3)) lines.push(`- ${titleOf(s.text)} [[${s.id}]]`);
  return lines.join("\n") + "\n";
}

function fakeTagging(prompt: string): string {
  const unescape = (t: string) => t.replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&");
  const title = unescape(/<title>([\s\S]*?)<\/title>/.exec(prompt)?.[1] ?? "");
  const body = unescape(/<article>\n?([\s\S]*?)\n?<\/article>/.exec(prompt)?.[1] ?? "");
  const words = title.split(/\s+/).filter(Boolean);
  const clickbait = /\?!\s*$/.test(title);
  return JSON.stringify({
    tags: words.filter((w) => /^[A-ZÄÖÜ][a-zäöüß]+$/.test(w)).slice(0, 2),
    entities: words.map((w) => w.replace(/[^\p{L}\p{N}-]/gu, "")).filter((w) => /^[A-Z]{2,6}$/.test(w) || /\d/.test(w)),
    sponsored: /\bAnzeige\b/.test(body),
    clickbait,
    cleanTitle: clickbait ? title.replace(/\s*\?!\s*$/, "") : null,
  });
}

function fakeSummary(prompt: string): string {
  const text = prompt.split(/\n\n(?:Article|Articles|Titles):\n/)[1] ?? prompt;
  return (text.match(/[^.!?]+[.!?]/g) ?? [text]).slice(0, 2).map((x) => x.trim()).join(" ");
}

/** Full output text of the fake for a prompt (model-independent part). */
export function fakeOutput(prompt: string): string {
  switch (taskOf(prompt)) {
    case "briefing":
      return fakeBriefing(prompt);
    case "tagging":
      return fakeTagging(prompt);
    default:
      return fakeSummary(prompt);
  }
}

export function fakeUsage(prompt: string, output: string) {
  return { in: Math.ceil(prompt.length / 4), out: Math.ceil(output.length / 4) };
}

function failFor(model: string) {
  if (model === "fake-error") throw new AiProviderError("provider_down", 503, "Fake 503: provider unavailable");
  if (model === "fake-auth") throw new AiProviderError("provider_auth", 401, "Fake 401: invalid key");
}

const sleep = (ms: number, signal?: AbortSignal) =>
  new Promise<void>((resolve, reject) => {
    if (signal?.aborted) return reject(signal.reason ?? new DOMException("Aborted", "AbortError"));
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener(
      "abort",
      () => {
        clearTimeout(timer);
        reject(signal.reason ?? new DOMException("Aborted", "AbortError"));
      },
      { once: true },
    );
  });

/** Non-streaming call (runAiPrompt). */
export async function fakePrompt(prompt: string, model: string | null | undefined): Promise<string> {
  assertFakeAiEnabled();
  const m = model || "fake";
  failFor(m);
  if (m === "fake-timeout") await new Promise(() => {});
  if (m === "fake-garbage") return "Hier ist eine schöne Zusammenfassung ohne jedes Format, ganz frei formuliert.";
  return fakeOutput(prompt);
}

export type StreamPart = { text: string } | { usage: { in: number; out: number } };

/** Streaming call: 7-char chunks (deliberately splitting `[[s1]]`), 5 ms apart (fake-slow: 60 ms). */
export async function* fakeStream(prompt: string, model: string | null | undefined, signal?: AbortSignal): AsyncGenerator<StreamPart> {
  assertFakeAiEnabled();
  const m = model || "fake";
  failFor(m);
  if (m === "fake-timeout") {
    await sleep(2 ** 31 - 1, signal);
    return;
  }
  const output = m === "fake-garbage" ? "Hier ist eine schöne Zusammenfassung ohne jedes Format, ganz frei formuliert.\n" : fakeOutput(prompt);
  const delay = m === "fake-slow" ? 60 : 5;
  for (let i = 0; i < output.length; i += CHUNK) {
    await sleep(delay, signal);
    yield { text: output.slice(i, i + CHUNK) };
  }
  yield { usage: fakeUsage(prompt, output) };
}
