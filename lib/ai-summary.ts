import { assertSafeFetchUrl, isTrustedFeedFetchingAllowed } from "@/lib/ssrf";

export type AiProvider = "openai" | "anthropic" | "ollama" | "gemini" | "openrouter";

export type AiConfig = {
  provider: AiProvider;
  apiKey?: string | null;
  model?: string | null;
  ollamaBaseUrl?: string | null;
  language?: string | null;
};

const MAX_CONTENT_CHARS = 8_000;

export function stripHtml(html: string) {
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
  return runAiPrompt(prompt, config);
}

export interface DigestSummaryArticle {
  title: string;
  excerpt?: string | null;
  feedName?: string | null;
}

function buildDigestPrompt(
  articles: DigestSummaryArticle[],
  mode: "full" | "per_feed",
  language: string | null | undefined,
): string {
  const langInstruction =
    !language || language === "same"
      ? "Respond in the same language the articles are written in."
      : `Respond in ${language}.`;

  const lines = articles.map((a, i) => {
    const head = a.feedName ? `[${a.feedName}] ${a.title}` : a.title;
    const excerpt = a.excerpt ? stripHtml(a.excerpt).slice(0, 400) : "";
    return `${i + 1}. ${head}${excerpt ? `\n   ${excerpt}` : ""}`;
  });

  const intro =
    mode === "full"
      ? `Below is a list of ${articles.length} article${articles.length === 1 ? "" : "s"} collected for an email digest. Write a concise overview (3–6 sentences) that captures the main themes and noteworthy items across all of them. Highlight what is most important or interesting. Do not list every single article — synthesize.`
      : `Below is a list of ${articles.length} article${articles.length === 1 ? "" : "s"} from a single news feed. Write a concise summary (2–4 sentences) that captures the key topics and highlights. Do not enumerate each article — synthesize the themes.`;

  return `${intro} ${langInstruction}\n\nArticles:\n${lines.join("\n")}`;
}

export async function generateDigestSummary(
  articles: DigestSummaryArticle[],
  mode: "full" | "per_feed",
  config: AiConfig,
): Promise<string> {
  if (articles.length === 0) return "";
  const prompt = buildDigestPrompt(articles, mode, config.language);
  return runAiPrompt(prompt, config);
}

export async function generateDigestSubject(
  articles: DigestSummaryArticle[],
  config: AiConfig,
): Promise<string> {
  if (articles.length === 0) return "";
  const titles = articles
    .slice(0, 8)
    .map((a) => a.title)
    .join("\n");
  const langInstruction =
    !config.language || config.language === "same"
      ? "Write the subject in the same language as the article titles."
      : `Write the subject in ${config.language}.`;
  const prompt = `Generate a concise email subject line (maximum 70 characters) for a reading digest containing the following article titles. Capture the 1–2 most interesting themes. Do not use quotes. Do not include the word "digest". ${langInstruction}\n\nTitles:\n${titles}`;
  return runAiPrompt(prompt, config);
}

export async function runAiPrompt(prompt: string, config: AiConfig, maxTokens = 300): Promise<string> {
  switch (config.provider) {
    case "openai":
      return summarizeOpenAI(prompt, config, maxTokens);
    case "anthropic":
      return summarizeAnthropic(prompt, config, maxTokens);
    case "ollama":
      return summarizeOllama(prompt, config, maxTokens);
    case "gemini":
      return summarizeGemini(prompt, config, maxTokens);
    case "openrouter":
      return summarizeOpenRouter(prompt, config, maxTokens);
    default:
      throw new Error(`Unknown AI provider: ${(config as any).provider}`);
  }
}

async function summarizeOpenAI(prompt: string, config: AiConfig, maxTokens = 300): Promise<string> {
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
      max_tokens: maxTokens,
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

async function summarizeAnthropic(prompt: string, config: AiConfig, maxTokens = 300): Promise<string> {
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
      max_tokens: maxTokens,
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

async function summarizeOllama(prompt: string, config: AiConfig, maxTokens = 300): Promise<string> {
  const base = (config.ollamaBaseUrl || "http://localhost:11434").replace(/\/$/, "");
  const model = config.model || "llama3";

  const allowInternal = await isTrustedFeedFetchingAllowed();
  try {
    await assertSafeFetchUrl(base, { context: "Ollama", allowInternal });
  } catch (err) {
    throw new Error(err instanceof Error ? err.message : "Ollama base URL is not allowed");
  }

  const res = await fetch(`${base}/api/chat`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      model,
      messages: [{ role: "user", content: prompt }],
      stream: false,
      options: { num_predict: maxTokens },
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

async function summarizeGemini(prompt: string, config: AiConfig, maxTokens = 300): Promise<string> {
  const model = config.model || "gemini-1.5-flash";
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${config.apiKey || ""}`;
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      contents: [{ parts: [{ text: prompt }] }],
      generationConfig: { maxOutputTokens: maxTokens },
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
async function summarizeOpenRouter(prompt: string, config: AiConfig, maxTokens = 300): Promise<string> {
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
      max_tokens: maxTokens,
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
