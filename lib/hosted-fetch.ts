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
  // Jina always requires a key. Firecrawl's is optional: null selects its
  // keyless free tier (see fetchViaFirecrawlDetailed) — no signup, capped
  // per server IP per day, shared across every user on this instance.
  apiKey: string | null;
};

export type HostedFetchResult = {
  content: string; // clean Markdown, as returned by the provider's own extraction
  title: string | null;
};

export type HostedFetchOutcome =
  | { ok: true; result: HostedFetchResult }
  | { ok: false; rateLimited: boolean };

/** Thrown by fetchAndExtractReadable when the hosted tier was the last hope and got rate-limited. */
export class HostedFetchRateLimitedError extends Error {
  constructor() {
    super("Hosted-fetch provider rate-limited this request");
    this.name = "HostedFetchRateLimitedError";
  }
}

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
async function fetchViaJinaDetailed(targetUrl: string, apiKey: string, timeoutMs: number): Promise<HostedFetchOutcome> {
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
    if (!response.ok) return { ok: false, rateLimited: response.status === 429 };
    const body = await readCappedText(response);
    if (!body) return { ok: false, rateLimited: false };
    const json = JSON.parse(body) as { data?: { title?: string; content?: string } };
    const content = json.data?.content;
    if (!content || !content.trim()) return { ok: false, rateLimited: false };
    return { ok: true, result: { content, title: json.data?.title?.trim() || null } };
  } catch {
    return { ok: false, rateLimited: false };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Firecrawl Cloud (api.firecrawl.dev): POST /v1/scrape requesting the
 * `markdown` format; response nests it under `data.markdown` with metadata
 * (including `title`) under `data.metadata`.
 *
 * `apiKey` is optional: Firecrawl's `/v1/scrape` also serves requests with no
 * Authorization header at all (verified directly against the live endpoint),
 * on a free tier capped per source-IP per day — no signup needed. Since every
 * user on a self-hosted instance shares this server's one outbound IP, that
 * daily cap is shared across all of them, not per-user; a real API key raises
 * it substantially. A 429 here is surfaced as `rateLimited` so the caller can
 * tell "try again later / add your own key" apart from "this page can't be
 * fetched at all".
 */
async function fetchViaFirecrawlDetailed(
  targetUrl: string,
  apiKey: string | null,
  timeoutMs: number,
): Promise<HostedFetchOutcome> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const headers: Record<string, string> = { "content-type": "application/json" };
    if (apiKey) headers.authorization = `Bearer ${apiKey}`;
    const response = await fetch("https://api.firecrawl.dev/v1/scrape", {
      method: "POST",
      headers,
      body: JSON.stringify({ url: targetUrl, formats: ["markdown"] }),
      signal: controller.signal,
    });
    if (!response.ok) return { ok: false, rateLimited: response.status === 429 };
    const body = await readCappedText(response);
    if (!body) return { ok: false, rateLimited: false };
    const json = JSON.parse(body) as {
      success?: boolean;
      data?: { markdown?: string; metadata?: { title?: string } };
    };
    if (!json.success) return { ok: false, rateLimited: false };
    const content = json.data?.markdown;
    if (!content || !content.trim()) return { ok: false, rateLimited: false };
    return { ok: true, result: { content, title: json.data?.metadata?.title?.trim() || null } };
  } catch {
    return { ok: false, rateLimited: false };
  } finally {
    clearTimeout(timer);
  }
}

export type FetchViaHostedApiOptions = {
  timeoutMs?: number;
};

/**
 * Fetches a page via the user's configured hosted API. The target URL is
 * still SSRF-validated (even though the *actual* request goes to the
 * third-party provider, not the target directly) to keep this consistent
 * with every other fetch tier and reject obviously-malicious internal URLs
 * before they're ever sent out. Never throws — callers that need to tell
 * "rate-limited" apart from "failed for some other reason" (e.g. to suggest
 * adding a real API key) should use `fetchViaHostedApiDetailed` instead.
 */
export async function fetchViaHostedApiDetailed(
  targetUrl: string,
  config: HostedFetchConfig,
  options: FetchViaHostedApiOptions = {},
): Promise<HostedFetchOutcome> {
  if (HOSTED_FETCH_DISABLED) return { ok: false, rateLimited: false };

  try {
    await assertSafeFetchUrl(targetUrl, {
      allowInternal: await isTrustedFeedFetchingAllowed(),
      context: "Hosted fetch",
    });
  } catch {
    return { ok: false, rateLimited: false };
  }

  const timeoutMs = options.timeoutMs ?? 30_000;
  if (config.provider === "jina") {
    // Jina always requires a key; no keyless tier is wired up for it.
    if (!config.apiKey) return { ok: false, rateLimited: false };
    return fetchViaJinaDetailed(targetUrl, config.apiKey, timeoutMs);
  }
  if (config.provider === "firecrawl") return fetchViaFirecrawlDetailed(targetUrl, config.apiKey, timeoutMs);
  return { ok: false, rateLimited: false };
}

/** Thin wrapper over `fetchViaHostedApiDetailed` for callers that only need the content, or null. */
export async function fetchViaHostedApi(
  targetUrl: string,
  config: HostedFetchConfig,
  options: FetchViaHostedApiOptions = {},
): Promise<HostedFetchResult | null> {
  const outcome = await fetchViaHostedApiDetailed(targetUrl, config, options);
  return outcome.ok ? outcome.result : null;
}

/**
 * Resolves a user's hosted-fetch BYOK config, or null when unconfigured,
 * disabled deployment-wide, or on any DB error. Never throws — mirrors
 * `getRenderSidecarConfig`'s resilience, since this can run on every
 * full-text fetch for a user who has it configured. A Firecrawl selection
 * with no stored key is valid — it opts into the keyless free tier — every
 * other provider requires one.
 */
export async function getHostedFetchConfigForUser(userId: string): Promise<HostedFetchConfig | null> {
  if (HOSTED_FETCH_DISABLED) return null;
  try {
    const user = await db.user.findUnique({
      where: { id: userId },
      select: { contentFetchProvider: true, contentFetchApiKey: true },
    });
    if (!user?.contentFetchProvider) return null;
    if (user.contentFetchProvider !== "jina" && user.contentFetchProvider !== "firecrawl") return null;
    const apiKey = decryptIfValue(user.contentFetchApiKey) || null;
    if (!apiKey && user.contentFetchProvider !== "firecrawl") return null;
    return { provider: user.contentFetchProvider, apiKey };
  } catch {
    return null;
  }
}
