import type { Frontends } from "./video-providers";
import { db } from "./db";
const TTL = 30_000;
type Entry<T> = { until: number; value: Promise<T> };
// Server actions and route bundles can instantiate this module separately.
// Keep one process-local store so invalidation reaches every bundle.
const root = globalThis as typeof globalThis & { __feedferretMediaSettings?: {
  globalMode?: Entry<string>;
  users: Map<string, Entry<boolean>>;
  frontends?: Map<string, Entry<Frontends & { uiLanguage?: string | null }>>;
} };
const store: NonNullable<typeof root.__feedferretMediaSettings> = root.__feedferretMediaSettings ??= { users: new Map<string, Entry<boolean>>() };
const users = store.users;

/** Same-process settings writes invalidate immediately; other replicas expire in 30s. */
export function clearMediaProxySettingsCache(userId?: string) {
  if (userId) { users.delete(userId); store.frontends?.delete(userId); }
  else { store.frontends?.clear(); store.globalMode = undefined; users.clear(); }
}

export async function mediaProxyEnabled(userId: string): Promise<boolean> {
  const now = Date.now();
  if (!store.globalMode || store.globalMode.until <= now) {
    const value = db.globalSettings.findUnique({ where: { id: "global" }, select: { mediaProxyMode: true } })
      .then(row => row?.mediaProxyMode ?? "off");
    const entry = { until: now + TTL, value };
    store.globalMode = entry;
    void value.catch(() => { if (store.globalMode === entry) store.globalMode = undefined; });
  }
  const mode = await store.globalMode.value;
  if (mode !== "opt-in") return mode === "on";
  let user = users.get(userId);
  if (!user || user.until <= now) {
    // Bound memory without evicting fresh entries on every image request.
    if (users.size >= 10_000) users.clear();
    const value = db.user.findUnique({ where: { id: userId }, select: { mediaProxyImages: true } })
      .then(row => row?.mediaProxyImages === true);
    user = { until: now + TTL, value };
    const entry = user;
    users.set(userId, entry);
    void value.catch(() => { if (users.get(userId) === entry) users.delete(userId); });
  }
  return user.value;
}

export async function mediaFrontends(userId: string): Promise<Frontends & { uiLanguage?: string | null }> {
  const cache = store.frontends ??= new Map();
  const old = cache.get(userId);
  if (old && old.until > Date.now()) return old.value;
  if (cache.size >= 10_000) cache.clear();
  const value = db.user.findUnique({ where: { id: userId }, select: {
    uiLanguage: true, mediaYoutubeInstance: true, mediaRedditFrontend: true, mediaTwitterInstance: true,
  } }).then(row => row ?? {});
  const entry = { until: Date.now() + TTL, value };
  cache.set(userId, entry);
  void value.catch(() => { if (cache.get(userId) === entry) cache.delete(userId); });
  return value;
}
