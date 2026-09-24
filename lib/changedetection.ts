// changedetection.io connector (feed-intelligence roadmap M5b): an optional,
// admin-configured self-hosted changedetection.io (https://changedetection.io)
// instance. "Monitor this page" creates a watch via its REST API; once
// changedetection.io has checked the page at least twice, its own per-watch
// RSS output becomes a normal feed — the same "just a plain RSS feed" design
// as the RSSHub connector (M5a). Because changedetection.io does its own
// browser rendering, this also reaches JS-only pages our in-process fetch
// path can't.
//
// Two DIFFERENT secrets are involved, confirmed from changedetection.io's
// own source (not guessed):
// - `apiKey`: the REST API key (`x-api-key` header), used to create/manage
//   watches via `/api/v1/*` (changedetectionio/api/Watch.py).
// - `rssToken`: a SEPARATE "RSS access token" (Settings → General → RSS
//   Access Token in changedetection.io's own UI), required as a `?token=`
//   query param on the per-watch RSS route. The REST API key does NOT work
//   here — `validate_rss_token` in changedetectionio/blueprint/rss/_util.py
//   checks the query token against `settings.application.rss_access_token`,
//   an entirely different value than the API key.
//
// Important UX asymmetry vs. RSSHub: a freshly created watch's RSS feed
// returns HTTP 400 ("does not have enough history snapshots... need at
// least 2") until changedetection.io has actually completed two checks on
// the target page — there is no way to synchronously validate "this feed
// has items" the way `validateRsshubRoute` can. Callers must not treat a
// successful `createWatch` as "the feed has content yet."

import { db } from "@/lib/db";
import { decryptIfValue } from "@/lib/crypto";
import { assertSafeFetchUrl, fetchTextWithSsrfProtection, isTrustedFeedFetchingAllowed } from "@/lib/ssrf";

export type ChangedetectionConfig = { baseUrl: string; apiKey: string; rssToken: string };

function truthy(value?: string) {
  return ["1", "true", "yes", "on"].includes(String(value || "").toLowerCase());
}

// Kill-switch, mirroring the impit/ftr/render-sidecar/rsshub toggles.
const CHANGEDETECTION_DISABLED = truthy(process.env.FEEDFERRET_DISABLE_CHANGEDETECTION);

/**
 * Resolves the effective changedetection.io config, or null when
 * unconfigured/disabled/incomplete (both secrets are required — a connector
 * with only one of the two can create watches but never read them back, or
 * vice versa, so treat a partial config as "not configured"). Never throws.
 */
export async function getChangedetectionConfig(): Promise<ChangedetectionConfig | null> {
  if (CHANGEDETECTION_DISABLED) return null;

  const envUrl = process.env.FEEDFERRET_CHANGEDETECTION_URL?.trim();
  if (envUrl) {
    const apiKey = process.env.FEEDFERRET_CHANGEDETECTION_API_KEY?.trim();
    const rssToken = process.env.FEEDFERRET_CHANGEDETECTION_RSS_TOKEN?.trim();
    if (!apiKey || !rssToken) return null;
    return { baseUrl: envUrl, apiKey, rssToken };
  }

  try {
    const settings = await db.globalSettings.findUnique({
      where: { id: "global" },
      select: {
        changedetectionEnabled: true,
        changedetectionBaseUrl: true,
        changedetectionApiKey: true,
        changedetectionRssToken: true,
      },
    });
    if (!settings?.changedetectionEnabled || !settings.changedetectionBaseUrl?.trim()) return null;
    const apiKey = decryptIfValue(settings.changedetectionApiKey);
    const rssToken = decryptIfValue(settings.changedetectionRssToken);
    if (!apiKey || !rssToken) return null;
    return { baseUrl: settings.changedetectionBaseUrl.trim(), apiKey, rssToken };
  } catch {
    return null;
  }
}

/** Cheap "is the changedetection.io connector available?" check for UI gating. */
export async function isChangedetectionConfigured(): Promise<boolean> {
  return (await getChangedetectionConfig()) !== null;
}

function apiUrl(config: ChangedetectionConfig, path: string): string {
  return `${config.baseUrl.replace(/\/+$/, "")}/api/v1${path}`;
}

/** Builds the per-watch RSS feed URL. This is just a plain RSS feed once changedetection.io has ≥2 snapshots. */
export function buildWatchFeedUrl(config: ChangedetectionConfig, uuid: string): string {
  const base = config.baseUrl.replace(/\/+$/, "");
  return `${base}/rss/watch/${uuid}?token=${encodeURIComponent(config.rssToken)}`;
}

export type CreateWatchInput = {
  url: string;
  title?: string;
  /** CSS/XPath selectors to extract specific content (changedetection.io's `include_filters`). */
  includeFilters?: string[];
  /** CSS/XPath selectors to remove from the page before diffing (`subtractive_selectors`). */
  subtractiveSelectors?: string[];
};

export type CreateWatchResult = { ok: true; uuid: string } | { ok: false; reason: string };

/**
 * Creates a changedetection.io watch for `input.url`. Both the
 * changedetection.io instance (trusted admin config) and the watched URL
 * (arbitrary user input) are SSRF-validated. Never throws.
 */
export async function createWatch(
  config: ChangedetectionConfig,
  input: CreateWatchInput,
): Promise<CreateWatchResult> {
  try {
    await assertSafeFetchUrl(input.url, {
      allowInternal: await isTrustedFeedFetchingAllowed(),
      context: "changedetection.io watch target",
    });
    await assertSafeFetchUrl(config.baseUrl, { allowInternal: true, context: "changedetection.io" });
  } catch (err) {
    return { ok: false, reason: err instanceof Error ? err.message : String(err) };
  }

  const body: Record<string, unknown> = { url: input.url };
  if (input.title) body.title = input.title;
  if (input.includeFilters?.length) body.include_filters = input.includeFilters;
  if (input.subtractiveSelectors?.length) body.subtractive_selectors = input.subtractiveSelectors;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 20_000);
  try {
    const res = await fetch(apiUrl(config, "/watch"), {
      method: "POST",
      headers: { "x-api-key": config.apiKey, "content-type": "application/json" },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      return {
        ok: false,
        reason: `changedetection.io responded with HTTP ${res.status}${text ? `: ${text.slice(0, 200)}` : ""}`,
      };
    }
    const data = await res.json().catch(() => null);
    const uuid = data && typeof data === "object" ? (data as Record<string, unknown>).uuid : undefined;
    if (typeof uuid !== "string" || !uuid) {
      return { ok: false, reason: "changedetection.io did not return a watch UUID" };
    }
    return { ok: true, uuid };
  } catch (err) {
    const timedOut = err instanceof Error && err.name === "AbortError";
    return { ok: false, reason: timedOut ? "Request timed out" : err instanceof Error ? err.message : String(err) };
  } finally {
    clearTimeout(timer);
  }
}

export type ConnectionTestResult =
  | { ok: true; version: string; discoveredRssToken?: string; rssTokenDiscoveryError?: string }
  | { ok: false; reason: string };

/**
 * Verifies the connector is reachable and authenticated, with no side
 * effects (`GET /api/v1/systeminfo` — no watch is created). Never throws.
 *
 * Also opportunistically runs RSS-token auto-discovery (see
 * `discoverRssToken` below) so a successful "Test connection" click can
 * offer to fill in the RSS token field for the admin, instead of making them
 * dig it out of the page source manually. Discovery failure never fails the
 * overall test — the API-key check above is what "success" means here.
 */
export async function testChangedetectionConnection(config: ChangedetectionConfig): Promise<ConnectionTestResult> {
  try {
    await assertSafeFetchUrl(config.baseUrl, { allowInternal: true, context: "changedetection.io test" });
  } catch (err) {
    return { ok: false, reason: err instanceof Error ? err.message : String(err) };
  }

  try {
    const res = await fetch(apiUrl(config, "/systeminfo"), {
      headers: { "x-api-key": config.apiKey },
      signal: AbortSignal.timeout(15_000),
    });
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      return { ok: false, reason: `HTTP ${res.status}${text ? `: ${text.slice(0, 200)}` : ""}` };
    }
    const data = await res.json().catch(() => ({}) as Record<string, unknown>);
    const version = typeof (data as Record<string, unknown>)?.version === "string" ? (data as Record<string, unknown>).version as string : "unknown";

    const discovery = await discoverRssToken(config.baseUrl);
    return discovery.ok
      ? { ok: true, version, discoveredRssToken: discovery.token }
      : { ok: true, version, rssTokenDiscoveryError: discovery.reason };
  } catch (err) {
    const timedOut = err instanceof Error && err.name === "AbortError";
    return { ok: false, reason: timedOut ? "Request timed out" : err instanceof Error ? err.message : String(err) };
  }
}

export type RssTokenDiscoveryResult = { ok: true; token: string } | { ok: false; reason: string };

// A watch-specific hex token, generally 32 hex chars in practice — accept a
// slightly wider range so we don't break on a future length change.
const RSS_TOKEN_RE = /token=([a-f0-9]{16,64})/i;

/**
 * changedetection.io auto-generates its RSS access token on first run and
 * never exposes it as a copyable field anywhere in Settings — confirmed
 * against its own source (`changedetectionio/templates/base.html`), it is
 * only ever embedded in an RSS-autodiscovery `<link>` tag in every page's
 * HTML `<head>`:
 *   <link rel="alternate" type="application/rss+xml" ... href="…?token=…">
 * Rather than making the admin dig this out manually (view-source / curl),
 * fetch the instance's homepage ourselves and pull the token out of that tag.
 * Never throws.
 */
export async function discoverRssToken(baseUrl: string): Promise<RssTokenDiscoveryResult> {
  let html: string;
  try {
    html = await fetchTextWithSsrfProtection(
      baseUrl,
      {},
      { allowInternal: true, timeoutMs: 15_000, maxBytes: 512 * 1024, context: "changedetection.io RSS token discovery" },
    );
  } catch (err) {
    return { ok: false, reason: err instanceof Error ? err.message : String(err) };
  }

  // Prefer the token from the actual RSS <link> tag over a bare "token="
  // scan of the whole page, so we don't accidentally pick up an unrelated
  // query param from some other link.
  const linkTags = html.match(/<link\b[^>]*>/gi) ?? [];
  const rssLinkTag = linkTags.find((tag) => /type=["']application\/rss\+xml["']/i.test(tag));
  const fromLinkTag = rssLinkTag?.match(RSS_TOKEN_RE)?.[1];
  const token = fromLinkTag ?? html.match(RSS_TOKEN_RE)?.[1];

  if (!token) {
    return {
      ok: false,
      reason:
        "Could not find the RSS token on the instance's homepage. If password protection is enabled on changedetection.io, disable it temporarily, or enter the token manually (see docs/self-hosting.md).",
    };
  }
  return { ok: true, token };
}
