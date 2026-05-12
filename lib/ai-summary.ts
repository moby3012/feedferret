export type AiProvider = "openai" | "anthropic" | "ollama" | "gemini" | "openrouter";

export type AiConfig = {
  provider: AiProvider;
  apiKey?: string | null;
  model?: string | null;
  ollamaBaseUrl?: string | null;
  language?: string | null;
};

const MAX_CONTENT_CHARS = 8_000;

function stripHtml(html: string) {
  return html.replace(/<[^>]*>?/gm, " ").replace(/\s+/g, " ").trim();
}

function buildPrompt(content: string, language: string | null | undefined) {
  const plain = stripHtml(content).slice(0, MAX_CONTENT_CHARS);
  const langInstruction =
    !language || language === "same"
      ? "Respond in the same language as the article."
      : `Respond in ${language}.`;
  return `Summarize the following article in 2–4 sentences. Be concise and capture the key points. ${langInstruction}\n\nArticle:\n${plain}`;
}

export async function generateSummary(rawContent: string, config: AiConfig): Promise<string> {
  const prompt = buildPrompt(rawContent, config.language);
  switch (config.provider) {
    case "openai":
      return summarizeOpenAI(prompt, config);
    case "anthropic":
      return summarizeAnthropic(prompt, config);
    case "ollama":
      return summarizeOllama(prompt, config);
    case "gemini":
      return summarizeGemini(prompt, config);
    case "openrouter":
      return summarizeOpenRouter(prompt, config);
    default:
      throw new Error(`Unknown AI provider: ${(config as any).provider}`);
  }
}

async function summarizeOpenAI(prompt: string, config: AiConfig): Promise<string> {
  const model = config.model || "gpt-4o-mini";
  const res = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${config.apiKey || ""}`,
    },
    body: JSON.stringify({
      model,
      messages: [{ role: "user", content: prompt }],
      max_tokens: 300,
    }),
    signal: AbortSignal.timeout(30_000),
  });
  if (!res.ok) {
    const err = await res.text().catch(() => "");
    throw new Error(`OpenAI ${res.status}: ${err.slice(0, 200)}`);
  }
  const data = await res.json();
  return String(data.choices?.[0]?.message?.content ?? "").trim();
}

async function summarizeAnthropic(prompt: string, config: AiConfig): Promise<string> {
  const model = config.model || "claude-haiku-4-5-20251001";
  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": config.apiKey || "",
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify({
      model,
      max_tokens: 300,
      messages: [{ role: "user", content: prompt }],
    }),
    signal: AbortSignal.timeout(30_000),
  });
  if (!res.ok) {
    const err = await res.text().catch(() => "");
    throw new Error(`Anthropic ${res.status}: ${err.slice(0, 200)}`);
  }
  const data = await res.json();
  return String(data.content?.[0]?.text ?? "").trim();
}

async function summarizeOllama(prompt: string, config: AiConfig): Promise<string> {
  const base = (config.ollamaBaseUrl || "http://localhost:11434").replace(/\/$/, "");
  const model = config.model || "llama3";
  const res = await fetch(`${base}/api/chat`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      model,
      messages: [{ role: "user", content: prompt }],
      stream: false,
    }),
    signal: AbortSignal.timeout(60_000),
  });
  if (!res.ok) {
    const err = await res.text().catch(() => "");
    throw new Error(`Ollama ${res.status}: ${err.slice(0, 200)}`);
  }
  const data = await res.json();
  return String(data.message?.content ?? "").trim();
}

async function summarizeGemini(prompt: string, config: AiConfig): Promise<string> {
  const model = config.model || "gemini-1.5-flash";
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${config.apiKey || ""}`;
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      contents: [{ parts: [{ text: prompt }] }],
      generationConfig: { maxOutputTokens: 300 },
    }),
    signal: AbortSignal.timeout(30_000),
  });
  if (!res.ok) {
    const err = await res.text().catch(() => "");
    throw new Error(`Gemini ${res.status}: ${err.slice(0, 200)}`);
  }
  const data = await res.json();
  return String(data.candidates?.[0]?.content?.parts?.[0]?.text ?? "").trim();
}

// OpenRouter uses OpenAI-compatible chat completions endpoint.
async function summarizeOpenRouter(prompt: string, config: AiConfig): Promise<string> {
  const model = config.model || "openai/gpt-4o-mini";
  const res = await fetch("https://openrouter.ai/api/v1/chat/completions", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${config.apiKey || ""}`,
      "HTTP-Referer": "https://github.com/feedferret/feedferret",
      "X-Title": "FeedFerret",
    },
    body: JSON.stringify({
      model,
      messages: [{ role: "user", content: prompt }],
      max_tokens: 300,
    }),
    signal: AbortSignal.timeout(30_000),
  });
  if (!res.ok) {
    const err = await res.text().catch(() => "");
    throw new Error(`OpenRouter ${res.status}: ${err.slice(0, 200)}`);
  }
  const data = await res.json();
  return String(data.choices?.[0]?.message?.content ?? "").trim();
}
