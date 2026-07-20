// RSSHub connector (feed-intelligence roadmap M5a): an optional,
// admin-configured self-hosted RSSHub (https://docs.rsshub.app/) instance.
// RSSHub turns platforms without their own RSS feed (YouTube channels,
// subreddits, GitHub repo releases, etc.) into real RSS/Atom feeds via its
// own well-documented route conventions — once the route is known, an
// RSSHub-backed feed IS just a plain RSS feed, so this module's whole job is
// building and validating that route URL. No new sourceType or sync path is
// needed: `validateRsshubRoute` reuses the same `fetchFeedArticles` every
// other RSS feed already goes through.

import { db } from "@/lib/db";
import { decryptIfValue } from "@/lib/crypto";
import { assertSafeFetchUrl } from "@/lib/ssrf";
import { fetchFeedArticles } from "@/lib/feed-fetcher";
import { type AiConfig, runAiPrompt } from "@/lib/ai-summary";

export type RsshubConfig = { baseUrl: string; apiKey: string | null };

function truthy(value?: string) {
  return ["1", "true", "yes", "on"].includes(String(value || "").toLowerCase());
}

// Kill-switch, mirroring the impit/ftr/render-sidecar toggles.
const RSSHUB_DISABLED = truthy(process.env.FEEDFERRET_DISABLE_RSSHUB);

/**
 * Resolves the effective RSSHub config, or null when unconfigured/disabled.
 * ENV (`FEEDFERRET_RSSHUB_URL` / `_KEY`) wins for immutable/container
 * deployments; otherwise the admin-managed GlobalSettings row is used.
 * Never throws: a DB error here must degrade to "not configured", not break
 * whatever is asking for it.
 */
export async function getRsshubConfig(): Promise<RsshubConfig | null> {
  if (RSSHUB_DISABLED) return null;

  const envUrl = process.env.FEEDFERRET_RSSHUB_URL?.trim();
  if (envUrl) {
    return { baseUrl: envUrl, apiKey: process.env.FEEDFERRET_RSSHUB_KEY?.trim() || null };
  }

  try {
    const settings = await db.globalSettings.findUnique({
      where: { id: "global" },
      select: { rsshubEnabled: true, rsshubBaseUrl: true, rsshubApiKey: true },
    });
    if (!settings?.rsshubEnabled || !settings.rsshubBaseUrl?.trim()) return null;
    return {
      baseUrl: settings.rsshubBaseUrl.trim(),
      apiKey: decryptIfValue(settings.rsshubApiKey) || null,
    };
  } catch {
    return null;
  }
}

/** Cheap "is the RSSHub connector available?" check for UI gating. */
export async function isRsshubConfigured(): Promise<boolean> {
  return (await getRsshubConfig()) !== null;
}

/** Builds the full route URL, appending RSSHub's optional `?key=` access gate. */
export function buildRsshubRouteUrl(config: RsshubConfig, routePath: string): string {
  const base = config.baseUrl.replace(/\/+$/, "");
  const path = routePath.startsWith("/") ? routePath : `/${routePath}`;
  const url = new URL(base + path);
  if (config.apiKey) url.searchParams.set("key", config.apiKey);
  return url.toString();
}

export type RsshubValidation =
  | { ok: true; title: string | null; itemCount: number; sampleTitles: string[] }
  | { ok: false; reason: string };

/**
 * Fetches and validates a candidate RSSHub route: it must be reachable
 * (SSRF-safe) and parse as a real feed with at least one item. Never throws.
 */
export async function validateRsshubRoute(config: RsshubConfig, routePath: string): Promise<RsshubValidation> {
  let url: string;
  try {
    url = buildRsshubRouteUrl(config, routePath);
  } catch {
    return { ok: false, reason: "Invalid RSSHub base URL or route" };
  }

  // The URL host is always the admin-configured RSSHub base (only the route
  // *path* varies), so internal/private Docker hostnames like rsshub:3000 are
  // trusted here — same as the changedetection.io connector's own API calls.
  // Without this, an internal RSSHub instance is rejected as an SSRF target
  // even during the admin "Test" step (before it's saved to the DB, so the
  // connector-host allowlist can't recognise it yet).
  try {
    await assertSafeFetchUrl(url, { allowInternal: true, context: "RSSHub" });
  } catch (err) {
    return { ok: false, reason: err instanceof Error ? err.message : String(err) };
  }

  try {
    const feed = await fetchFeedArticles({ url, allowInternal: true });
    if (!feed.articles.length) {
      return { ok: false, reason: "RSSHub returned a feed with no items for this route" };
    }
    return {
      ok: true,
      title: feed.title ?? null,
      itemCount: feed.articles.length,
      sampleTitles: feed.articles.slice(0, 5).map((a) => a.title).filter(Boolean),
    };
  } catch (err) {
    return { ok: false, reason: err instanceof Error ? err.message : "Could not read that route as a feed" };
  }
}

/** Builds the strict-JSON prompt asking the model to propose an RSSHub route for a source description/URL. */
export function buildRoutePrompt(sourceDescription: string): string {
  return `You are mapping a content source to an RSSHub (https://docs.rsshub.app/) route path.

The user wants a feed for: ${sourceDescription}

Respond with STRICT JSON only — no prose, no markdown code fences, no explanation outside the JSON object, in exactly this shape:
{"route":"/youtube/channel/UC_x5XG1OV2P6uZZ5FSM9Ttw"}

The route must be a real RSSHub route path (starting with "/") for a well-known RSSHub route category (youtube, reddit, github, twitter, bilibili, telegram, etc.), with the specific channel/user/repo/subreddit identifier filled in from what the user gave you. If you cannot confidently determine a route, respond with exactly: {"route":null}`;
}

/**
 * Extracts the JSON object from the model's raw text (tolerating ```json
 * fences and surrounding prose). Returns `null` on any parse/shape failure,
 * or when the model reported it couldn't determine a route.
 */
export function parseRouteProposal(rawText: string): string | null {
  if (typeof rawText !== "string") return null;

  const start = rawText.indexOf("{");
  const end = rawText.lastIndexOf("}");
  if (start === -1 || end === -1 || end < start) return null;

  let parsed: unknown;
  try {
    parsed = JSON.parse(rawText.slice(start, end + 1));
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== "object") return null;

  const route = (parsed as Record<string, unknown>).route;
  if (typeof route !== "string" || !route.trim().startsWith("/")) return null;
  return route.trim();
}

export type RouteProposalResult = { route: string; validation: RsshubValidation };

/**
 * Orchestrator: asks the AI to propose an RSSHub route for `sourceDescription`
 * (typically a pasted platform URL, e.g. a YouTube channel page), then
 * validates that proposal through a real RSSHub round-trip before it would
 * ever be trusted — mirrors M4's "AI proposes, engine validates" pattern.
 * Returns `null` if the AI can't confidently propose a route at all; a
 * proposal that fails validation is still returned (with the reason) so the
 * caller can show it rather than a silent failure.
 */
export async function proposeAndValidateRoute(
  sourceDescription: string,
  aiConfig: AiConfig,
  rsshubConfig: RsshubConfig,
): Promise<RouteProposalResult | null> {
  const prompt = buildRoutePrompt(sourceDescription);
  const raw = await runAiPrompt(prompt, aiConfig, 200);
  const route = parseRouteProposal(raw);
  if (!route) return null;
  const validation = await validateRsshubRoute(rsshubConfig, route);
  return { route, validation };
}
