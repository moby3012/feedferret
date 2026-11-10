// Streaming AI calls (K2): one async generator per provider wire format,
// yielding text deltas and (when the provider reports it) token usage.
//   OpenAI / OpenRouter  SSE, `stream:true` + `stream_options.include_usage`
//   Anthropic            SSE, `content_block_delta` / `message_start|delta` usage
//   Ollama               NDJSON, `stream:true`, `options:{num_predict, num_ctx:4096}`
//   Gemini               SSE, `:streamGenerateContent?alt=sse`
//   fake                 lib/ai/fake.ts (CI only)
// An error before the first chunk falls back to the non-streaming
// `runAiPrompt` once (some proxies / older Ollama builds refuse streaming);
// auth errors do not (they would fail the same way).
import { safeFetch, assertSafeFetchUrl, isTrustedFeedFetchingAllowed } from "@/lib/ssrf";
import { runAiPrompt, type AiConfig } from "@/lib/ai-summary";
import { AiProviderError, codeForStatus } from "./errors";
import { fakeStream, isFakeAiEnabled, type StreamPart } from "./fake";

export type { StreamPart };

export interface StreamOptions {
  maxTokens: number;
  signal?: AbortSignal;
}

type Usage = { in: number; out: number };

const MAX_STREAM_LINE_CHARS = 1024 * 1024;

async function* lines(body: ReadableStream<Uint8Array>, signal?: AbortSignal): AsyncGenerator<string> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  const onAbort = () => void reader.cancel().catch(() => {});
  signal?.addEventListener("abort", onAbort, { once: true });
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let nl = buffer.indexOf("\n");
      while (nl !== -1) {
        yield buffer.slice(0, nl).replace(/\r$/, "");
        buffer = buffer.slice(nl + 1);
        nl = buffer.indexOf("\n");
      }
      // A (possibly user-chosen, e.g. Ollama) endpoint streaming one endless
      // line must not grow this buffer without bound (N10).
      if (buffer.length > MAX_STREAM_LINE_CHARS) throw new Error("AI stream line too long");
    }
    buffer += decoder.decode();
    if (buffer) yield buffer;
  } finally {
    signal?.removeEventListener("abort", onAbort);
    reader.releaseLock();
  }
}

/** `data:` payloads of an SSE body (comments, `event:` lines and `[DONE]` skipped). */
async function* sseData(body: ReadableStream<Uint8Array>, signal?: AbortSignal): AsyncGenerator<any> {
  for await (const line of lines(body, signal)) {
    if (!line.startsWith("data:")) continue;
    const data = line.slice(5).trim();
    if (!data || data === "[DONE]") continue;
    try {
      yield JSON.parse(data);
    } catch {
      /* partial / non-JSON keep-alive */
    }
  }
}

// ─── Per-format event parsers (pure, unit-tested against recorded bodies) ───

export function openAiPart(event: any): StreamPart[] {
  const out: StreamPart[] = [];
  const text = event?.choices?.[0]?.delta?.content;
  if (typeof text === "string" && text) out.push({ text });
  const u = event?.usage;
  if (u && typeof u.prompt_tokens === "number") out.push({ usage: { in: u.prompt_tokens, out: u.completion_tokens ?? 0 } });
  return out;
}

export function geminiPart(event: any): StreamPart[] {
  const out: StreamPart[] = [];
  const parts = event?.candidates?.[0]?.content?.parts;
  if (Array.isArray(parts)) {
    const text = parts.map((p: any) => (typeof p?.text === "string" ? p.text : "")).join("");
    if (text) out.push({ text });
  }
  const u = event?.usageMetadata;
  if (u && typeof u.promptTokenCount === "number") out.push({ usage: { in: u.promptTokenCount, out: u.candidatesTokenCount ?? 0 } });
  return out;
}

export function ollamaPart(event: any): StreamPart[] {
  const out: StreamPart[] = [];
  const text = event?.message?.content;
  if (typeof text === "string" && text) out.push({ text });
  if (event?.done && typeof event.prompt_eval_count === "number") out.push({ usage: { in: event.prompt_eval_count, out: event.eval_count ?? 0 } });
  return out;
}

/** Anthropic needs state across events (input tokens arrive first, output tokens last). */
export function anthropicParser() {
  const usage: Usage = { in: 0, out: 0 };
  return (event: any): StreamPart[] => {
    if (event?.type === "content_block_delta" && event.delta?.type === "text_delta" && typeof event.delta.text === "string") {
      return [{ text: event.delta.text }];
    }
    if (event?.type === "message_start" && event.message?.usage) {
      usage.in = event.message.usage.input_tokens ?? 0;
      usage.out = event.message.usage.output_tokens ?? 0;
      return [];
    }
    if (event?.type === "message_delta" && event.usage) {
      usage.out = event.usage.output_tokens ?? usage.out;
      return [];
    }
    if (event?.type === "message_stop") return [{ usage: { ...usage } }];
    if (event?.type === "error") throw new AiProviderError("provider_down", null, "Anthropic stream error");
    return [];
  };
}

// ─── Requests ───────────────────────────────────────────────────────────────

async function postStream(provider: string, url: string, init: RequestInit): Promise<ReadableStream<Uint8Array>> {
  const res = await safeFetch(url, { ...init, method: "POST" }, { allowInternal: await isTrustedFeedFetchingAllowed() });
  if (!res.ok || !res.body) {
    await res.body?.cancel().catch(() => {});
    throw new AiProviderError(codeForStatus(res.status), res.status, `${provider} ${res.status}`);
  }
  return res.body;
}

async function* openAiCompatible(provider: "OpenAI" | "OpenRouter", prompt: string, config: AiConfig, o: StreamOptions): AsyncGenerator<StreamPart> {
  const isRouter = provider === "OpenRouter";
  const body = await postStream(provider, isRouter ? "https://openrouter.ai/api/v1/chat/completions" : "https://api.openai.com/v1/chat/completions", {
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${config.apiKey || ""}`,
      ...(isRouter ? { "HTTP-Referer": "https://github.com/feedferret/feedferret", "X-Title": "FeedFerret" } : {}),
    },
    body: JSON.stringify({
      model: config.model || (isRouter ? "openai/gpt-4o-mini" : "gpt-4o-mini"),
      messages: [{ role: "user", content: prompt }],
      max_tokens: o.maxTokens,
      stream: true,
      stream_options: { include_usage: true },
    }),
    signal: o.signal,
  });
  for await (const event of sseData(body, o.signal)) yield* openAiPart(event);
}

async function* anthropic(prompt: string, config: AiConfig, o: StreamOptions): AsyncGenerator<StreamPart> {
  const body = await postStream("Anthropic", "https://api.anthropic.com/v1/messages", {
    headers: { "Content-Type": "application/json", "x-api-key": config.apiKey || "", "anthropic-version": "2023-06-01" },
    body: JSON.stringify({
      model: config.model || "claude-haiku-4-5-20251001",
      max_tokens: o.maxTokens,
      messages: [{ role: "user", content: prompt }],
      stream: true,
    }),
    signal: o.signal,
  });
  const parse = anthropicParser();
  for await (const event of sseData(body, o.signal)) yield* parse(event);
}

async function* gemini(prompt: string, config: AiConfig, o: StreamOptions): AsyncGenerator<StreamPart> {
  const model = config.model || "gemini-1.5-flash";
  const body = await postStream(
    "Gemini",
    `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:streamGenerateContent?alt=sse`,
    {
      headers: { "Content-Type": "application/json", "x-goog-api-key": config.apiKey || "" },
      body: JSON.stringify({ contents: [{ parts: [{ text: prompt }] }], generationConfig: { maxOutputTokens: o.maxTokens } }),
      signal: o.signal,
    },
  );
  for await (const event of sseData(body, o.signal)) yield* geminiPart(event);
}

async function* ollama(prompt: string, config: AiConfig, o: StreamOptions): AsyncGenerator<StreamPart> {
  const base = (config.ollamaBaseUrl || "http://localhost:11434").replace(/\/$/, "");
  const allowInternal = await isTrustedFeedFetchingAllowed();
  try {
    await assertSafeFetchUrl(base, { context: "Ollama", allowInternal });
  } catch (err) {
    throw new AiProviderError("provider_down", null, err instanceof Error ? err.message : "Ollama base URL is not allowed");
  }
  const body = await postStream("Ollama", `${base}/api/chat`, {
    redirect: "manual",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      model: config.model || "llama3",
      messages: [{ role: "user", content: prompt }],
      stream: true,
      options: { num_predict: o.maxTokens, num_ctx: 4096 },
    }),
    signal: o.signal,
  });
  for await (const line of lines(body, o.signal)) {
    if (!line.trim()) continue;
    let event: any;
    try {
      event = JSON.parse(line);
    } catch {
      continue;
    }
    if (typeof event?.error === "string") throw new AiProviderError("provider_down", null, "Ollama stream error");
    yield* ollamaPart(event);
  }
}

function providerStream(prompt: string, config: AiConfig, o: StreamOptions): AsyncGenerator<StreamPart> {
  switch (config.provider) {
    case "openai":
      return openAiCompatible("OpenAI", prompt, config, o);
    case "openrouter":
      return openAiCompatible("OpenRouter", prompt, config, o);
    case "anthropic":
      return anthropic(prompt, config, o);
    case "gemini":
      return gemini(prompt, config, o);
    case "ollama":
      return ollama(prompt, config, o);
    case "fake":
      if (isFakeAiEnabled()) return fakeStream(prompt, config.model, o.signal);
      throw new Error("Unknown AI provider: fake");
    default:
      throw new Error(`Unknown AI provider: ${String((config as { provider: unknown }).provider)}`);
  }
}

/**
 * Streams one prompt. Usage accounting is the caller's job (the briefing
 * generator records provider-reported usage, else an estimate) — `config.usage`
 * is ignored here so a fallback call never double-counts.
 */
export async function* streamAiPrompt(prompt: string, config: AiConfig, o: StreamOptions): AsyncGenerator<StreamPart> {
  let started = false;
  try {
    for await (const part of providerStream(prompt, config, o)) {
      if ("text" in part) started = true;
      yield part;
    }
  } catch (error) {
    if (started || o.signal?.aborted) throw error;
    if (error instanceof AiProviderError && error.code === "provider_auth") throw error;
    if (error instanceof Error && error.message.startsWith("Unknown AI provider")) throw error;
    // Error before the first chunk: one non-streaming attempt.
    const text = await runAiPrompt(prompt, { ...config, usage: undefined }, o.maxTokens);
    yield { text };
  }
}
