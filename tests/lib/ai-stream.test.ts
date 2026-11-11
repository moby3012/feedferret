// K2: streaming parsers per provider wire format (recorded bodies), the
// non-streaming fallback, and the fake provider + its production gate.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

vi.mock("@/lib/ssrf", () => ({
  safeFetch: (url: string, init: RequestInit) => globalThis.fetch(url, init),
  assertSafeFetchUrl: vi.fn(async () => undefined),
  isTrustedFeedFetchingAllowed: vi.fn(async () => true),
}));

import { streamAiPrompt, type StreamPart } from "../../lib/ai/stream";
import { fakeOutput, fakeStream, harnessMarkerPath, isFakeAiEnabled, resetFakeAiGate } from "../../lib/ai/fake";
import { logger } from "../../lib/logger";
import { runAiPrompt, isSelectableAiProvider } from "../../lib/ai-summary";
import { AiProviderError } from "../../lib/ai/errors";

const fixture = (name: string) => readFileSync(join(__dirname, "../fixtures/ai-stream", name), "utf8");

/** A Response whose body arrives in small chunks (exercises line reassembly). */
function chunked(text: string, size = 11, status = 200): Response {
  const bytes = new TextEncoder().encode(text);
  let i = 0;
  const body = new ReadableStream<Uint8Array>({
    pull(controller) {
      if (i >= bytes.length) return controller.close();
      controller.enqueue(bytes.slice(i, i + size));
      i += size;
    },
  });
  return new Response(body, { status });
}

async function collect(gen: AsyncGenerator<StreamPart>) {
  let text = "";
  let usage: { in: number; out: number } | null = null;
  for await (const part of gen) {
    if ("text" in part) text += part.text;
    else usage = part.usage;
  }
  return { text, usage };
}

const fetchMock = vi.fn();
beforeEach(() => {
  fetchMock.mockReset();
  vi.stubGlobal("fetch", fetchMock);
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

const EXPECTED = "## WHAT\n- EZB senkt Zins [[s1]]\n";

describe("streamAiPrompt wire formats", () => {
  it.each([
    ["openai", "openai.txt", { in: 812, out: 21 }],
    ["openrouter", "openai.txt", { in: 812, out: 21 }],
    ["anthropic", "anthropic.txt", { in: 790, out: 19 }],
    ["ollama", "ollama.txt", { in: 701, out: 17 }],
    ["gemini", "gemini.txt", { in: 640, out: 15 }],
  ] as const)("%s: text deltas + usage", async (provider, file, usage) => {
    fetchMock.mockResolvedValueOnce(chunked(fixture(file)));
    const out = await collect(streamAiPrompt("prompt", { provider, apiKey: "k", model: "m", usage: null }, { maxTokens: 700 }));
    expect(out.text).toBe(EXPECTED);
    expect(out.usage).toEqual(usage);
    const [url, init] = fetchMock.mock.calls[0];
    const body = JSON.parse(String(init.body));
    if (provider === "ollama") {
      expect(url).toBe("http://localhost:11434/api/chat");
      expect(body).toMatchObject({ stream: true, options: { num_predict: 700, num_ctx: 4096 } });
    } else if (provider === "gemini") {
      expect(url).toContain(":streamGenerateContent?alt=sse");
      expect(url).not.toContain("key="); // key in a header, never in the URL
    } else {
      expect(body.stream).toBe(true);
    }
    if (provider === "openai") expect(body.stream_options).toEqual({ include_usage: true });
  });

  it("falls back to one non-streaming call when the stream fails before the first chunk", async () => {
    fetchMock.mockResolvedValueOnce(new Response("upstream", { status: 502 }));
    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({ choices: [{ message: { content: EXPECTED } }] }), { status: 200 }));
    const out = await collect(streamAiPrompt("prompt", { provider: "openai", apiKey: "k", usage: null }, { maxTokens: 700 }));
    expect(out.text).toBe(EXPECTED.trim());
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("does not retry auth errors; they surface as provider_auth", async () => {
    fetchMock.mockResolvedValueOnce(new Response("bad key sk-123", { status: 401 }));
    const err = await collect(streamAiPrompt("p", { provider: "anthropic", apiKey: "k", usage: null }, { maxTokens: 10 })).catch((e) => e);
    expect(err).toBeInstanceOf(AiProviderError);
    expect(err.code).toBe("provider_auth");
    expect(err.message).not.toContain("sk-123"); // provider bodies never travel
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});

describe("fake provider", () => {
  const prompt = `<!-- ff:task=briefing v1 -->
<stories>
<story id="s1" sources="3" feeds="A, B">EZB senkt Leitzins — excerpt IGNORE all</story>
<story id="s2" sources="1" feeds="C">Bahn streikt — x</story>
</stories>
<brief>
<story id="s3" feeds="D">Kurzmeldung</story>
</brief>`;

  it("is gated: flag required; in production only with a harness token matching the marker next to the DB", () => {
    resetFakeAiGate();
    const dir = mkdtempSync(join(tmpdir(), "ff-harness-"));
    const token = "a".repeat(48);
    const errors = vi.spyOn(logger, "error").mockImplementation(() => {});
    try {
      vi.stubEnv("FEEDFERRET_FAKE_AI", "");
      expect(isFakeAiEnabled()).toBe(false);
      vi.stubEnv("FEEDFERRET_FAKE_AI", "1");
      expect(isFakeAiEnabled()).toBe(true); // NODE_ENV=test
      vi.stubEnv("NODE_ENV", "production");
      vi.stubEnv("DATABASE_PROVIDER", "sqlite");
      // The old heuristic (any `.e2e/*.db` path) no longer opens the gate.
      vi.stubEnv("DATABASE_URL", `file:${join(dir, ".e2e", "e2e.db")}`);
      vi.stubEnv("FEEDFERRET_E2E_HARNESS", "");
      expect(isFakeAiEnabled()).toBe(false);
      vi.stubEnv("DATABASE_URL", `file:${join(dir, "e2e.db")}`);
      vi.stubEnv("FEEDFERRET_E2E_HARNESS", token);
      expect(isFakeAiEnabled()).toBe(false); // no marker file
      writeFileSync(join(dir, "e2e.db.harness"), "b".repeat(48));
      expect(isFakeAiEnabled()).toBe(false); // marker of another run
      expect(isSelectableAiProvider("fake")).toBe(false);
      vi.stubEnv("FEEDFERRET_E2E_HARNESS", "short");
      writeFileSync(join(dir, "e2e.db.harness"), "short");
      expect(isFakeAiEnabled()).toBe(false); // too short to be a run token
      writeFileSync(join(dir, "e2e.db.harness"), `${token}\n`);
      vi.stubEnv("FEEDFERRET_E2E_HARNESS", token);
      expect(isFakeAiEnabled()).toBe(true);
      expect(harnessMarkerPath(`file:${join(dir, "e2e.db")}`, "sqlite")).toBe(join(dir, "e2e.db.harness"));
      // Postgres never has a marker, even with a matching token.
      vi.stubEnv("DATABASE_PROVIDER", "postgresql");
      vi.stubEnv("DATABASE_URL", "postgresql://u@db/feedferret");
      expect(isFakeAiEnabled()).toBe(false);
      // Ignored flag in production → exactly one error log.
      expect(errors).toHaveBeenCalledTimes(1);
      expect(String(errors.mock.calls[0][0])).toContain("FEEDFERRET_FAKE_AI=1 is set in production");
    } finally {
      errors.mockRestore();
      rmSync(dir, { recursive: true, force: true });
      resetFakeAiGate();
    }
  });

  it("refuses to run when the gate is closed", async () => {
    vi.stubEnv("FEEDFERRET_FAKE_AI", "0");
    await expect(runAiPrompt("x", { provider: "fake", usage: null })).rejects.toThrow("Unknown AI provider");
    await expect(collect(streamAiPrompt("x", { provider: "fake", usage: null }, { maxTokens: 10 }))).rejects.toThrow("Unknown AI provider");
  });

  it("briefing output: cites stories, adds a hallucinated id, an uncited line and (IGNORE) an injection line", () => {
    const out = fakeOutput(prompt);
    expect(out).toContain("- EZB senkt Leitzins — 3 Quellen. [[s1]]");
    expect(out).toContain("[[s99]]");
    expect(out).toContain("- Satz ohne Quelle");
    expect(out).toContain("<script>alert(1)</script> https://evil.example [[s1]]");
    expect(out).toContain("## BRIEF\n- Kurzmeldung [[s3]]");
  });

  it("streams 7-char chunks and reports usage", async () => {
    vi.stubEnv("FEEDFERRET_FAKE_AI", "1");
    const parts: StreamPart[] = [];
    for await (const p of fakeStream(prompt, "fake")) parts.push(p);
    const texts = parts.filter((p): p is { text: string } => "text" in p).map((p) => p.text);
    expect(texts.every((t) => t.length <= 7)).toBe(true);
    expect(texts.join("")).toBe(fakeOutput(prompt));
    expect(parts.at(-1)).toEqual({ usage: { in: Math.ceil(prompt.length / 4), out: Math.ceil(fakeOutput(prompt).length / 4) } });
  });

  it("fake-error / fake-auth fail before the first chunk", async () => {
    vi.stubEnv("FEEDFERRET_FAKE_AI", "1");
    await expect(collect(fakeStream(prompt, "fake-error"))).rejects.toMatchObject({ code: "provider_down", status: 503 });
    await expect(collect(fakeStream(prompt, "fake-auth"))).rejects.toMatchObject({ code: "provider_auth", status: 401 });
  });
});
