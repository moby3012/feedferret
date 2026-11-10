// Deterministic fake AI provider (.pm/spec-ai-briefing.md §6) — the only
// provider CI ever talks to; no network. Behaviour is picked by `aiModel`
// (fake | fake-slow | fake-local | fake-error | fake-auth | fake-garbage |
// fake-timeout) and
// the task by the `<!-- ff:task=… -->` marker every K prompt starts with.
//
// Gate: never available in a real deployment. It needs FEEDFERRET_FAKE_AI=1
// AND either a non-production NODE_ENV (vitest, `next dev`) or — the e2e
// harness serves a production build — a per-run harness token: the
// Playwright config generates a random FEEDFERRET_E2E_HARNESS token per run,
// scripts/e2e-seed.mjs writes it into a marker file next to the freshly seeded
// SQLite DB (`<db>.harness`), and only a server whose env token matches that
// file's content enables the fake. A production instance with the flag set by
// mistake has no such marker: the flag is ignored and an error is logged once.
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { timingSafeEqual } from "node:crypto";
import { logger } from "@/lib/logger";
import { AiProviderError } from "./errors";

export const FAKE_MODELS = ["fake", "fake-slow", "fake-local", "fake-error", "fake-auth", "fake-garbage", "fake-timeout"] as const;

/** Marker file of the e2e harness for a SQLite `DATABASE_URL` (`file:/abs/e2e.db` → `/abs/e2e.db.harness`). */
export function harnessMarkerPath(databaseUrl: string | undefined, provider: string | undefined): string | null {
  const kind = (provider || "sqlite").toLowerCase();
  if (kind !== "sqlite" && kind !== "file") return null;
  const m = /^file:([^?]+)/.exec(databaseUrl ?? "");
  return m ? `${resolve(m[1])}.harness` : null;
}

const MIN_TOKEN_CHARS = 32;
const verified = new Set<string>();
let loggedIgnored = false;

function harnessTokenMatches(): boolean {
  const token = process.env.FEEDFERRET_E2E_HARNESS ?? "";
  const marker = harnessMarkerPath(process.env.DATABASE_URL, process.env.DATABASE_PROVIDER);
  if (token.length < MIN_TOKEN_CHARS || !marker) return false;
  const key = `${marker}\0${token}`;
  if (verified.has(key)) return true;
  let content: string;
  try {
    content = readFileSync(marker, "utf8").trim();
  } catch {
    return false;
  }
  const a = Buffer.from(content);
  const b = Buffer.from(token);
  const ok = a.length === b.length && timingSafeEqual(a, b);
  if (ok) verified.add(key);
  return ok;
}

export function isFakeAiEnabled(): boolean {
  if (process.env.FEEDFERRET_FAKE_AI !== "1") return false;
  if (process.env.NODE_ENV !== "production") return true;
  if (harnessTokenMatches()) return true;
  if (!loggedIgnored) {
    loggedIgnored = true;
    logger.error("[ai] FEEDFERRET_FAKE_AI=1 is set in production without a matching e2e harness token — ignored; the fake AI provider stays disabled.");
  }
  return false;
}

/** Tests only: forget verified tokens and the one-time log. */
export function resetFakeAiGate(): void {
  verified.clear();
  loggedIgnored = false;
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
  // (Starts with the story's title so it passes the grounding guard and the sanitizer is what removes tag + URL.)
  if (stories.some((s) => s.text.includes("IGNORE"))) lines.push(`- ${titleOf(stories[0].text)} <script>alert(1)</script> https://evil.example [[s1]]`);
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

/**
 * `fake-local` stands in for a local (Ollama-like) provider in the briefing UI:
 * the card auto-generates for it (lib/briefing/generate.ts). Streams like fake-slow.
 */
export const isFakeLocalModel = (model: string | null | undefined) => model === "fake-local";

/** Streaming call: 7-char chunks (deliberately splitting `[[s1]]`), 5 ms apart (fake-slow / fake-local: 60 ms). */
export async function* fakeStream(prompt: string, model: string | null | undefined, signal?: AbortSignal): AsyncGenerator<StreamPart> {
  assertFakeAiEnabled();
  const m = model || "fake";
  failFor(m);
  if (m === "fake-timeout") {
    await sleep(2 ** 31 - 1, signal);
    return;
  }
  const output = m === "fake-garbage" ? "Hier ist eine schöne Zusammenfassung ohne jedes Format, ganz frei formuliert.\n" : fakeOutput(prompt);
  const delay = m === "fake-slow" || m === "fake-local" ? 60 : 5;
  for (let i = 0; i < output.length; i += CHUNK) {
    await sleep(delay, signal);
    yield { text: output.slice(i, i + CHUNK) };
  }
  yield { usage: fakeUsage(prompt, output) };
}
