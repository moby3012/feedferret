/** Pure registry shared by URL validation, discovery, OPML and API dispatch.
 * Internal feeds never contain credentials or an arbitrary fetch destination. */
export const API_PLATFORM_SOURCES = [{
  id: "twitch", name: "Twitch", hosts: ["twitch.tv", "www.twitch.tv", "m.twitch.tv"],
  apiOrigin: "https://api.twitch.tv",
  setupHint: "needs-twitch",
  account: /^[a-z0-9_]{1,25}$/,
  route: /^\/([a-z0-9_]{1,25})(?:\/(?:videos|clips))?\/?$/i,
  variants: ["live", "videos", "clips"],
  labels: { de: ["Live-Status", "Videos (VODs/Highlights)", "Clips"], en: ["Live status", "Videos (VODs/Highlights)", "Clips"] },
}] as const;

export function parseApiSourceUrl(raw: string) {
  try {
    const url = new URL(raw);
    const source = API_PLATFORM_SOURCES.find((s) => s.id === url.hostname);
    const parts = url.pathname.split("/");
    if (url.protocol !== "feedferret:" || !source || url.username || url.password || url.port || url.search || url.hash || parts.length !== 3) return null;
    const [, account, variant] = parts;
    if (!source.account.test(account) || !(source.variants as readonly string[]).includes(variant)) return null;
    return { source, account, variant };
  } catch { return null; }
}

export function matchApiPlatform(url: URL) {
  const source = API_PLATFORM_SOURCES.find((s) => (s.hosts as readonly string[]).includes(url.hostname.toLowerCase()));
  const account = source?.route.exec(url.pathname)?.[1]?.toLowerCase();
  return source && account ? { source, account } : null;
}
