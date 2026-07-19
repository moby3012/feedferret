// BYOK hosted-API connector (M7-T3, the last "heavy fetch" tier).
//
// For pages an active anti-bot challenge blocks even a real headless browser
// (the render sidecar, M7-T2), a user can bring their own API key for a
// commercial "URL to clean content" service — Jina Reader or Firecrawl Cloud
// — which run far more sophisticated, actively-maintained anti-bot
// infrastructure than we ever could in-process.
//
// Unlike every earlier tier, this sends the target page's content to a third
// party outside the user's own infrastructure — so it is per-user (not an
// admin-global default, unlike the render sidecar), strictly opt-in, and
// labelled accordingly wherever it's configured or used. Same BYOK pattern as
// the AI-summary feature (lib/ai-summary.ts): provider + API key stored
// encrypted on the User row.
//
// Honest limits: this reliably clears many *soft* anti-bot walls and paywalls
// these services already have deals/workarounds for, but even they cannot
// promise success against every active challenge — never advertise this tier
// as "always works".

import { db } from "@/lib/db";
import { decryptIfValue } from "@/lib/crypto";
import { assertSafeFetchUrl, isTrustedFeedFetchingAllowed } from "@/lib/ssrf";

export type HostedFetchProvider = "jina" | "firecrawl";

export type HostedFetchConfig = {
  provider: HostedFetchProvider;
  apiKey: string;
};

export type HostedFetchResult = {
  content: string; // clean Markdown, as returned by the provider's own extraction
  title: string | null;
};

// Kill-switch, mirroring the impit/ftr/render-sidecar toggles — lets an admin
// disable this tier deployment-wide regardless of what any user configures.
function truthy(value?: string) {
  return ["1", "true", "yes", "on"].includes(String(value || "").toLowerCase());
}
const HOSTED_FETCH_DISABLED = truthy(process.env.FEEDFERRET_DISABLE_HOSTED_FETCH);

const MAX_RESPONSE_BYTES = 4 * 1024 * 1024;

async function readCappedText(response: Response): Promise<string | null> {
  const buffer = await response.arrayBuffer();
  if (buffer.byteLength > MAX_RESPONSE_BYTES) return null;
  return new TextDecoder().decode(buffer);
}

/**
 * Jina Reader (r.jina.ai): GET the target URL prefixed onto the reader
 * endpoint; requesting JSON gives back structured { data: { title, content } }
 * where `content` is already clean Markdown.
 */
async function fetchViaJina(targetUrl: string, apiKey: string, timeoutMs: number): Promise<HostedFetchResult | null> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(`https://r.jina.ai/${targetUrl}`, {
      headers: {
        authorization: `Bearer ${apiKey}`,
        accept: "application/json",
      },
      signal: controller.signal,
    });
    if (!response.ok) return null;
    const body = await readCappedText(response);
    if (!body) return null;
    const json = JSON.parse(body) as { data?: { title?: string; content?: string } };
    const content = json.data?.content;
    if (!content || !content.trim()) return null;
    return { content, title: json.data?.title?.trim() || null };
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Firecrawl Cloud (api.firecrawl.dev): POST /v1/scrape requesting the
 * `markdown` format; response nests it under `data.markdown` with metadata
 * (including `title`) under `data.metadata`.
 */
async function fetchViaFirecrawl(
  targetUrl: string,
  apiKey: string,
  timeoutMs: number,
): Promise<HostedFetchResult | null> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch("https://api.firecrawl.dev/v1/scrape", {
      method: "POST",
      headers: {
        authorization: `Bearer ${apiKey}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({ url: targetUrl, formats: ["markdown"] }),
      signal: controller.signal,
    });
    if (!response.ok) return null;
    const body = await readCappedText(response);
    if (!body) return null;
    const json = JSON.parse(body) as {
      success?: boolean;
      data?: { markdown?: string; metadata?: { title?: string } };
    };
    if (!json.success) return null;
    const content = json.data?.markdown;
    if (!content || !content.trim()) return null;
    return { content, title: json.data?.metadata?.title?.trim() || null };
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

export type FetchViaHostedApiOptions = {
  timeoutMs?: number;
};

/**
 * Fetches a page via the user's configured hosted API and returns its clean
 * Markdown content, or null on any failure. Never throws — this is always a
 * best-effort last resort. The target URL is still SSRF-validated (even
 * though the *actual* request goes to the third-party provider, not the
 * target directly) to keep this consistent with every other fetch tier and
 * reject obviously-malicious internal URLs before they're ever sent out.
 */
export async function fetchViaHostedApi(
  targetUrl: string,
  config: HostedFetchConfig,
  options: FetchViaHostedApiOptions = {},
): Promise<HostedFetchResult | null> {
  if (HOSTED_FETCH_DISABLED) return null;

  try {
    await assertSafeFetchUrl(targetUrl, {
      allowInternal: await isTrustedFeedFetchingAllowed(),
      context: "Hosted fetch",
    });
  } catch {
    return null;
  }

  const timeoutMs = options.timeoutMs ?? 30_000;
  if (config.provider === "jina") return fetchViaJina(targetUrl, config.apiKey, timeoutMs);
  if (config.provider === "firecrawl") return fetchViaFirecrawl(targetUrl, config.apiKey, timeoutMs);
  return null;
}

/**
 * Resolves a user's hosted-fetch BYOK config, or null when unconfigured,
 * disabled deployment-wide, or on any DB error. Never throws — mirrors
 * `getRenderSidecarConfig`'s resilience, since this can run on every
 * full-text fetch for a user who has it configured.
 */
export async function getHostedFetchConfigForUser(userId: string): Promise<HostedFetchConfig | null> {
  if (HOSTED_FETCH_DISABLED) return null;
  try {
    const user = await db.user.findUnique({
      where: { id: userId },
      select: { contentFetchProvider: true, contentFetchApiKey: true },
    });
    if (!user?.contentFetchProvider || !user.contentFetchApiKey) return null;
    const apiKey = decryptIfValue(user.contentFetchApiKey);
    if (!apiKey) return null;
    if (user.contentFetchProvider !== "jina" && user.contentFetchProvider !== "firecrawl") return null;
    return { provider: user.contentFetchProvider, apiKey };
  } catch {
    return null;
  }
}
