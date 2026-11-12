import { createHash } from "node:crypto";
import { db } from "./db";
import { decryptIfValue } from "./crypto";
import { safeFetch } from "./ssrf";
import { hostBackoffRemainingMs, recordHostRateLimit } from "./host-backoff";
import type { FetchedFeed } from "./feed-item-fields";

export const TWITCH_SETUP_MESSAGE = "Enable Twitch in Admin → Server settings: create an app at dev.twitch.tv/console (redirect http://localhost, category Website Integration), then save Client ID and Client Secret.";
export type TwitchCredentials = { clientId: string; clientSecret: string };
export async function getTwitchCredentials(): Promise<TwitchCredentials | null> {
  const settings = await db.globalSettings.findUnique({ where: { id: "global" }, select: { twitchClientId: true, twitchClientSecret: true } });
  const clientSecret = decryptIfValue(settings?.twitchClientSecret, "globalSettings.twitchClientSecret");
  return settings?.twitchClientId && clientSecret ? { clientId: settings.twitchClientId, clientSecret } : null;
}

// A credential fingerprint invalidates the token immediately after settings
// change. Single flight prevents concurrent syncs from minting extra tokens.
let cached: { key: string; token: string; expires: number } | undefined;
let pending: { key: string; promise: Promise<string> } | undefined;
async function accessToken(credentials: TwitchCredentials, signal?: AbortSignal): Promise<string> {
  const key = createHash("sha256").update(JSON.stringify(credentials)).digest("hex");
  if (cached?.key === key && cached.expires > Date.now() + 60_000) return cached.token;
  if (pending?.key === key) return pending.promise;
  const promise = (async () => {
    const response = await safeFetch("https://id.twitch.tv/oauth2/token", {
      method: "POST", signal, headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ client_id: credentials.clientId, client_secret: credentials.clientSecret, grant_type: "client_credentials" }).toString(),
    });
    // Never surface upstream response bodies: OAuth errors can contain secrets.
    if (!response.ok) { await response.body?.cancel(); throw new Error("Twitch authentication failed. Check the Client ID and Client Secret."); }
    const data = await response.json();
    if (typeof data.access_token !== "string" || !Number.isFinite(data.expires_in) || data.expires_in <= 0) throw new Error("Invalid Twitch token response");
    cached = { key, token: data.access_token, expires: Date.now() + data.expires_in * 1000 };
    return cached.token;
  })();
  pending = { key, promise };
  try { return await promise; } finally { if (pending?.promise === promise) pending = undefined; }
}

type HelixItem = { id: string; title: string; url?: string; thumbnail_url?: string; created_at?: string; started_at?: string; game_name?: string; user_name?: string; display_name?: string; duration?: string | number; type?: string };
export async function twitchRequest(path: string, params: Record<string, string>, credentials: TwitchCredentials, signal?: AbortSignal): Promise<HelixItem[]> {
  signal = signal ? AbortSignal.any([signal, AbortSignal.timeout(30_000)]) : AbortSignal.timeout(30_000);
  const url = new URL(`https://api.twitch.tv/helix/${path}`);
  url.search = new URLSearchParams(params).toString();
  for (let attempt = 0; attempt < 2; attempt++) {
    if (hostBackoffRemainingMs(url.href)) throw new Error("Twitch rate limit reached. Retry after the API reset.");
    const token = await accessToken(credentials, signal);
    const response = await safeFetch(url.href, { signal, headers: { "Client-ID": credentials.clientId, Authorization: `Bearer ${token}` } });
    const reset = Number(response.headers.get("Ratelimit-Reset"));
    if (response.headers.get("Ratelimit-Remaining") === "0" || response.status === 429) recordHostRateLimit(url.href, Number.isFinite(reset) && reset * 1000 > Date.now() ? reset * 1000 : Date.now() + 60_000);
    if (response.status === 401 && attempt === 0) { cached = undefined; await response.body?.cancel(); continue; }
    if (!response.ok) { await response.body?.cancel(); throw new Error(`Twitch API request failed (${response.status})`); }
    const data = await response.json();
    if (!Array.isArray(data.data)) throw new Error("Invalid Twitch API response");
    return data.data;
  }
  throw new Error("Twitch authentication failed");
}

export async function fetchTwitchFeed(login: string, variant: string, signal?: AbortSignal): Promise<FetchedFeed> {
  const credentials = await getTwitchCredentials();
  if (!credentials) throw new Error(TWITCH_SETUP_MESSAGE);
  const [user] = await twitchRequest("users", { login }, credentials, signal);
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
