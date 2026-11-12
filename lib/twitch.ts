import { createHash } from "node:crypto";
import { db } from "./db";
import { decryptIfValue } from "./crypto";
import { safeFetch } from "./ssrf";
import { hostBackoffRemainingMs, recordHostRateLimit } from "./host-backoff";
import type { FetchedFeed } from "./feed-item-fields";
import { ApiSourceDeferredError, isApiSourceDeferredError } from "./api-source-errors";

export const TWITCH_SETUP_MESSAGE = "Enable Twitch in Admin → Server settings: create an app at dev.twitch.tv/console (redirect http://localhost, category Website Integration), then save Client ID and Client Secret.";
export type TwitchCredentials = { clientId: string; clientSecret: string };
export async function getTwitchCredentials(): Promise<TwitchCredentials | null> {
  const settings = await db.globalSettings.findUnique({ where: { id: "global" }, select: { twitchClientId: true, twitchClientSecret: true } });
  const clientSecret = decryptIfValue(settings?.twitchClientSecret, "globalSettings.twitchClientSecret");
  return settings?.twitchClientId && clientSecret ? { clientId: settings.twitchClientId, clientSecret } : null;
}

// A credential fingerprint invalidates the token immediately after settings
// change. Single flight prevents concurrent syncs from minting extra tokens.
const TOKEN_MINT_TIMEOUT_MS = 15_000;
const TOKEN_FAILURE_BACKOFF_MS = 60_000;
let cached: { key: string; token: string; expires: number } | undefined;
let pending: { key: string; promise: Promise<string> } | undefined;
// Failed mint → reuse the failure for a minute instead of hammering id.twitch.tv
// once per feed (and per retry) with credentials that were just rejected.
// Only auth rejections and quota answers are remembered; network errors/5xx are not.
const failedMints = new Map<string, { until: number; status?: number; reason: "auth" | "rate-limited" }>();

// Process-level: last time the shared credentials were rejected (shown in the admin section).
let credentialError: { at: number; status?: number } | null = null;
export function getTwitchCredentialError(): { at: string; status?: number } | null {
  return credentialError ? { at: new Date(credentialError.at).toISOString(), status: credentialError.status } : null;
}
export function clearTwitchCredentialError() { credentialError = null; }
const AUTH_MESSAGE = "Twitch authentication failed. Check the Client ID and Client Secret.";
const AUTH_STATUSES = new Set([400, 401, 403]);

const credentialKey = (credentials: TwitchCredentials) => createHash("sha256").update(JSON.stringify(credentials)).digest("hex");

/** Test hook: forget every in-memory token / negative / user-id cache. */
export function resetTwitchCaches() {
  cached = undefined; pending = undefined; failedMints.clear(); userIds.clear(); credentialError = null;
}

async function mintToken(credentials: TwitchCredentials): Promise<{ token: string; expiresInSecs: number }> {
  // Own timeout: a joined single-flight must not depend on the first caller's signal.
  let response: Response;
  try {
    response = await safeFetch("https://id.twitch.tv/oauth2/token", {
      method: "POST", signal: AbortSignal.timeout(TOKEN_MINT_TIMEOUT_MS), headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ client_id: credentials.clientId, client_secret: credentials.clientSecret, grant_type: "client_credentials" }).toString(),
    });
  } catch {
    throw new ApiSourceDeferredError("transient", "Twitch is temporarily unreachable. Retrying on the next sync.");
  }
  // Never surface upstream response bodies: OAuth errors can contain secrets.
  if (!response.ok) {
    await response.body?.cancel();
    const { status } = response;
    if (AUTH_STATUSES.has(status)) throw new ApiSourceDeferredError("auth", AUTH_MESSAGE, status);
    if (status === 429) throw new ApiSourceDeferredError("rate-limited", "Twitch rate limit reached. Retry after the API reset.", status, TOKEN_FAILURE_BACKOFF_MS);
    throw new ApiSourceDeferredError("transient", `Twitch is temporarily unavailable (${status}). Retrying on the next sync.`, status);
  }
  const data = await response.json().catch(() => null);
  if (typeof data?.access_token !== "string" || !Number.isFinite(data.expires_in) || data.expires_in <= 0) throw new ApiSourceDeferredError("transient", "Invalid Twitch token response");
  return { token: data.access_token, expiresInSecs: data.expires_in };
}

/** `ephemeral` (connection tests): mint a throw-away token, touch no shared cache. */
async function accessToken(credentials: TwitchCredentials, ephemeral = false): Promise<string> {
  if (ephemeral) return (await mintToken(credentials)).token;
  const key = credentialKey(credentials);
  if (cached?.key === key && cached.expires > Date.now() + 60_000) return cached.token;
  const failed = failedMints.get(key);
  if (failed && failed.until > Date.now()) {
    throw failed.reason === "auth"
      ? new ApiSourceDeferredError("auth", AUTH_MESSAGE, failed.status)
      : new ApiSourceDeferredError("rate-limited", "Twitch rate limit reached. Retry after the API reset.", failed.status, failed.until - Date.now());
  }
  if (pending?.key === key) return pending.promise;
  const promise = (async () => {
    try {
      const { token, expiresInSecs } = await mintToken(credentials);
      cached = { key, token, expires: Date.now() + expiresInSecs * 1000 };
      failedMints.delete(key);
      credentialError = null;
      return token;
    } catch (error) {
      const deferred = isApiSourceDeferredError(error) ? error : new ApiSourceDeferredError("transient", "Twitch is temporarily unreachable. Retrying on the next sync.");
      if (deferred.reason === "auth" || deferred.reason === "rate-limited") {
        if (failedMints.size > 50) failedMints.clear();
        failedMints.set(key, { until: Date.now() + TOKEN_FAILURE_BACKOFF_MS, status: deferred.status, reason: deferred.reason });
      }
      if (deferred.reason === "auth") credentialError = { at: Date.now(), status: deferred.status };
      throw deferred;
    }
  })();
  pending = { key, promise };
  try { return await promise; } finally { if (pending?.promise === promise) pending = undefined; }
}

/** An API answer that is a real per-request failure (not a deferred condition). */
export class TwitchApiError extends Error {
  constructor(readonly status: number) { super(`Twitch API request failed (${status})`); this.name = "TwitchApiError"; }
}

type HelixItem = { id: string; title: string; url?: string; thumbnail_url?: string; created_at?: string; started_at?: string; game_name?: string; user_name?: string; display_name?: string; duration?: string | number; type?: string };
export async function twitchRequest(path: string, params: Record<string, string>, credentials: TwitchCredentials, signal?: AbortSignal, options: { ephemeral?: boolean } = {}): Promise<HelixItem[]> {
  signal = signal ? AbortSignal.any([signal, AbortSignal.timeout(30_000)]) : AbortSignal.timeout(30_000);
  const url = new URL(`https://api.twitch.tv/helix/${path}`);
  url.search = new URLSearchParams(params).toString();
  for (let attempt = 0; attempt < 2; attempt++) {
    const backoffMs = hostBackoffRemainingMs(url.href);
    if (backoffMs) throw new ApiSourceDeferredError("rate-limited", "Twitch rate limit reached. Retry after the API reset.", undefined, backoffMs);
    const token = await accessToken(credentials, options.ephemeral);
    const response = await safeFetch(url.href, { signal, headers: { "Client-ID": credentials.clientId, Authorization: `Bearer ${token}` } });
    const reset = Number(response.headers.get("Ratelimit-Reset"));
    if (response.headers.get("Ratelimit-Remaining") === "0" || response.status === 429) recordHostRateLimit(url.href, Number.isFinite(reset) && reset * 1000 > Date.now() ? reset * 1000 : Date.now() + 60_000);
    if (response.status === 401 && attempt === 0) {
      // Drop only the token this request used: a concurrent caller may already have replaced it.
      if (!options.ephemeral && cached?.token === token) cached = undefined;
      await response.body?.cancel();
      continue;
    }
    if (response.status === 429) { await response.body?.cancel(); throw new ApiSourceDeferredError("rate-limited", "Twitch API request failed (429)", 429, hostBackoffRemainingMs(url.href) || undefined); }
    if (response.status === 401) { await response.body?.cancel(); credentialError = options.ephemeral ? credentialError : { at: Date.now(), status: 401 }; throw new ApiSourceDeferredError("auth", AUTH_MESSAGE, 401); }
    if (!response.ok) { await response.body?.cancel(); throw new TwitchApiError(response.status); }
    const data = await response.json();
    if (!Array.isArray(data.data)) throw new Error("Invalid Twitch API response");
    return data.data;
  }
  throw new ApiSourceDeferredError("auth", AUTH_MESSAGE);
}

// login → user id/display name rarely changes: skip the extra `users` call on
// every poll (one per feed per sync) and across discovery → first sync.
const USER_ID_TTL_MS = 6 * 3600_000;
const USER_ID_MAX = 2000;
const userIds = new Map<string, { id: string; displayName?: string; expires: number }>();
type TwitchUser = { id: string; display_name?: string };
/** Resolves a login via Helix `users` (cached for hours); null when the channel does not exist. */
export async function resolveTwitchUser(login: string, credentials: TwitchCredentials, signal?: AbortSignal): Promise<TwitchUser | null> {
  const hit = userIds.get(login);
  if (hit && hit.expires > Date.now()) return { id: hit.id, display_name: hit.displayName };
  const [user] = await twitchRequest("users", { login }, credentials, signal);
  if (!user) return null;
  if (userIds.size >= USER_ID_MAX) userIds.delete(userIds.keys().next().value as string);
  userIds.set(login, { id: user.id, displayName: user.display_name, expires: Date.now() + USER_ID_TTL_MS });
  return user;
}

export async function fetchTwitchFeed(login: string, variant: string, signal?: AbortSignal): Promise<FetchedFeed> {
  const credentials = await getTwitchCredentials();
  if (!credentials) throw new ApiSourceDeferredError("unconfigured", TWITCH_SETUP_MESSAGE);
  const user = await resolveTwitchUser(login, credentials, signal);
  if (!user) throw new Error("Twitch channel not found");
  const htmlUrl = `https://www.twitch.tv/${login}`;
  const now = new Date();
  const items = variant === "live"
    ? await twitchRequest("streams", { user_id: user.id }, credentials, signal)
    : variant === "videos"
      ? (await twitchRequest("videos", { user_id: user.id, first: "100", sort: "time" }, credentials, signal)).filter((v) => v.type === "archive" || v.type === "highlight")
      : await twitchRequest("clips", { broadcaster_id: user.id, first: "100", started_at: new Date(now.getTime() - 7 * 86400_000).toISOString(), ended_at: now.toISOString() }, credentials, signal);
  return { title: `Twitch · ${user.display_name || login} · ${variant}`, htmlUrl, articles: items.map((item) => ({
    guid: item.id, externalId: item.id, title: item.title,
    // A broadcast-specific fragment keeps default link-based dedupe distinct
    // across streams while repeated polls of one broadcast remain identical.
    link: variant === "live" ? `${htmlUrl}#stream-${item.id}` : item.url || htmlUrl,
    content: "", summary: item.game_name || null, categories: item.game_name ? [item.game_name] : [],
    author: item.user_name || user.display_name || login,
    publishedAt: new Date(item.started_at || item.created_at || now.toISOString()),
    imageUrl: item.thumbnail_url?.replaceAll("%{width}", "640").replaceAll("%{height}", "360").replaceAll("{width}", "640").replaceAll("{height}", "360"),
    durationSecs: typeof item.duration === "number" ? item.duration : durationSeconds(item.duration),
  })) };
}
function durationSeconds(value?: string): number | null {
  if (!value) return null;
  let seconds = 0;
  for (const part of value.matchAll(/(\d{1,9})([hms])/g)) seconds += Number(part[1]) * ({ h: 3600, m: 60, s: 1 }[part[2]] || 0);
  return seconds || null;
}
