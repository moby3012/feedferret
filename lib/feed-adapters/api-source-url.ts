/** Pure registry shared by URL validation, discovery, OPML and API dispatch.
 * Internal feeds never contain credentials or an arbitrary fetch destination. */
export const API_PLATFORM_SOURCES = [{
  id: "twitch", name: "Twitch", hosts: ["twitch.tv", "www.twitch.tv", "m.twitch.tv"],
  apiOrigin: "https://api.twitch.tv",
  account: /^[a-z0-9_]{1,25}$/,
  route: /^\/([a-z0-9_]{1,25})(?:\/(?:videos|clips))?\/?$/i,
  variants: [
    { id: "live", label: { de: "Live-Status", en: "Live status" } },
    { id: "videos", label: { de: "Videos (VODs/Highlights)", en: "Videos (VODs/Highlights)" } },
    { id: "clips", label: { de: "Clips", en: "Clips" } },
  ],
}] as const;

/** Parses an internal API-source URL. Scheme, source id and account are
 * case-insensitive on input (`FEEDFERRET://Twitch/Example/live`); the returned
 * `account` is lower-cased. Use `canonicalApiSourceUrl` to store/compare. */
export function parseApiSourceUrl(raw: string) {
  try {
    const url = new URL(raw);
    const host = url.hostname.toLowerCase();
    const source = API_PLATFORM_SOURCES.find((s) => s.id === host);
    const parts = url.pathname.toLowerCase().split("/");
    if (url.protocol !== "feedferret:" || !source || url.username || url.password || url.port || url.search || url.hash || parts.length !== 3) return null;
    const [, account, variant] = parts;
    if (!source.account.test(account) || !source.variants.some((v) => v.id === variant)) return null;
    return { source, account, variant };
  } catch { return null; }
}

/** The one stored/deduplicated spelling of an internal API-source URL, or null. */
export function canonicalApiSourceUrl(raw: string): string | null {
  const parsed = parseApiSourceUrl(raw);
  return parsed ? `feedferret://${parsed.source.id}/${parsed.account}/${parsed.variant}` : null;
}

export function matchApiPlatform(url: URL) {
  const source = API_PLATFORM_SOURCES.find((s) => (s.hosts as readonly string[]).includes(url.hostname.toLowerCase()));
  const account = source?.route.exec(url.pathname)?.[1]?.toLowerCase();
  return source && account ? { source, account } : null;
}
