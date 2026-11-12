import { beforeEach, describe, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({ fetch: vi.fn(), settings: vi.fn(), decrypt: vi.fn() }));
vi.mock("@/lib/db", () => ({ db: { globalSettings: { findUnique: mocks.settings } } }));
vi.mock("@/lib/crypto", () => ({ decryptIfValue: mocks.decrypt }));
vi.mock("@/lib/ssrf", () => ({ safeFetch: mocks.fetch }));
import { fetchTwitchFeed, twitchRequest, getTwitchCredentials } from "../../lib/twitch";
import { hostBackoffRemainingMs, resetHostBackoff } from "../../lib/host-backoff";
import { matchApiPlatform, parseApiSourceUrl } from "../../lib/feed-adapters/api-source-url";
import { normalizeUrlInput } from "../../lib/url-input";
import { validateFeedUrl } from "../../lib/validation";
import { generateOpml, parseOpml } from "../../lib/opml";
const reply = (data: unknown, status = 200, headers = {}) => new Response(JSON.stringify(data), { status, headers });
let sequence = 0;
beforeEach(() => {
  vi.clearAllMocks(); resetHostBackoff();
  mocks.settings.mockResolvedValue({ twitchClientId: `synthetic-${++sequence}`, twitchClientSecret: "sealed" });
  mocks.decrypt.mockReturnValue("synthetic-secret");
  mocks.fetch.mockImplementation(async (url: string) => url.includes("oauth2/token") ? reply({ access_token: "synthetic-token", expires_in: 3600 }) : url.includes("/users?") ? reply({ data: [{ id: "123", display_name: "Example" }] }) : reply({ data: [] }));
});
describe("official Twitch API platform source", () => {
  it.each(["", "/videos", "/clips"])("matches channel route %s and offers registered variants", (suffix) => {
    expect(matchApiPlatform(new URL(`https://www.twitch.tv/example${suffix}`))?.source.variants).toEqual(["live", "videos", "clips"]);
    expect(matchApiPlatform(new URL("https://twitch.tv.example.com/example"))).toBeNull();
  });
  it("keeps internal feeds strict and round-trips through OPML", async () => {
    for (const variant of ["live", "videos", "clips"]) {
      const url = `feedferret://twitch/example/${variant}`;
      expect(parseApiSourceUrl(url)?.variant).toBe(variant);
      expect(normalizeUrlInput(url)).toMatchObject({ ok: true, url });
      expect(validateFeedUrl(url)).toBeNull();
      expect((await parseOpml(generateOpml([{ name: variant, url }])))[0].xmlUrl).toBe(url);
    }
    for (const url of ["feedferret://evil/example/live", "feedferret://twitch/example/live?secret=x", "feedferret://twitch/example/unknown", "feedferret://twitch/a:b/live"]) expect(parseApiSourceUrl(url)).toBeNull();
  });
  it("returns nothing while offline and caches the app token", async () => {
    expect((await fetchTwitchFeed("example", "live")).articles).toEqual([]);
    await fetchTwitchFeed("example", "live");
    const tokens = mocks.fetch.mock.calls.filter(([url]) => url.includes("oauth2/token"));
    expect(tokens).toHaveLength(1);
    expect(tokens[0][0]).toBe("https://id.twitch.tv/oauth2/token");
    expect(tokens[0][1].body).toContain("grant_type=client_credentials");
    expect(tokens[0][0]).not.toContain("secret");
  });
  it("uses stable IDs and distinct broadcast links across repeated syncs", async () => {
    mocks.fetch.mockImplementation(async (url: string) => url.includes("oauth2/token") ? reply({ access_token: "token", expires_in: 3600 }) : url.includes("/users?") ? reply({ data: [{ id: "123" }] }) : reply({ data: [{ id: "broadcast-1", title: "Hello", game_name: "Game", started_at: "2026-01-01T12:00:00Z", thumbnail_url: "https://example.com/{width}x{height}.jpg" }] }));
    const first = (await fetchTwitchFeed("example", "live")).articles[0];
    expect(first).toMatchObject({ guid: "broadcast-1", externalId: "broadcast-1", link: "https://www.twitch.tv/example#stream-broadcast-1", summary: "Game", imageUrl: "https://example.com/640x360.jpg" });
    expect((await fetchTwitchFeed("example", "live")).articles[0]).toEqual(first);
  });
  it("maps VOD duration and thumbnail and excludes uploads", async () => {
    mocks.fetch.mockImplementation(async (url: string) => url.includes("oauth2/token") ? reply({ access_token: "token", expires_in: 3600 }) : url.includes("/users?") ? reply({ data: [{ id: "123" }] }) : reply({ data: [{ id: "v1", title: "Archive", type: "archive", duration: "1h2m3s", url: "https://www.twitch.tv/videos/v1", thumbnail_url: "https://example.com/%{width}x%{height}.jpg" }, { id: "upload", type: "upload" }] }));
    const feed = await fetchTwitchFeed("example", "videos");
    expect(feed.articles).toHaveLength(1);
    expect(feed.articles[0]).toMatchObject({ guid: "v1", durationSecs: 3723, imageUrl: "https://example.com/640x360.jpg" });
  });
  it("requests top 100 clips within exactly seven days", async () => {
    await fetchTwitchFeed("example", "clips");
    const url = new URL(mocks.fetch.mock.calls.find(([url]) => url.includes("/clips?"))![0]);
    expect(url.searchParams.get("first")).toBe("100");
    expect(Date.parse(url.searchParams.get("ended_at")!) - Date.parse(url.searchParams.get("started_at")!)).toBe(7 * 86400_000);
  });
  it("refreshes once on 401", async () => {
    mocks.fetch.mockReset().mockResolvedValueOnce(reply({ access_token: "old", expires_in: 3600 })).mockResolvedValueOnce(reply({}, 401)).mockResolvedValueOnce(reply({ access_token: "new", expires_in: 3600 })).mockResolvedValueOnce(reply({ data: [] }));
    await twitchRequest("users", { login: "example" }, { clientId: "refresh-test", clientSecret: "secret" });
    expect(mocks.fetch).toHaveBeenCalledTimes(4);
    expect(mocks.fetch.mock.calls[3][1].headers.Authorization).toBe("Bearer new");
  });
  it("honours rate-limit reset even on a successful response", async () => {
    mocks.fetch.mockReset().mockResolvedValueOnce(reply({ access_token: "token", expires_in: 3600 })).mockResolvedValueOnce(reply({ data: [] }, 200, { "Ratelimit-Remaining": "0", "Ratelimit-Reset": String(Math.ceil(Date.now() / 1000) + 90) }));
    const creds = { clientId: "limit-test", clientSecret: "secret" };
    await twitchRequest("users", {}, creds);
    expect(hostBackoffRemainingMs("https://api.twitch.tv/helix/clips")).toBeGreaterThan(89_000);
    await expect(twitchRequest("users", {}, creds)).rejects.toThrow("rate limit");
    expect(mocks.fetch).toHaveBeenCalledTimes(2);
  });
  it("requires admin credentials and decrypts with the field purpose", async () => {
    mocks.settings.mockResolvedValue(null); mocks.decrypt.mockReturnValue(null);
    expect(await getTwitchCredentials()).toBeNull();
    await expect(fetchTwitchFeed("example", "live")).rejects.toThrow("Server settings");
    expect(mocks.fetch).not.toHaveBeenCalled();
  });
});

it("discovers three native variants without reading the Twitch website", async () => {
  const { discoverFeeds } = await import("../../lib/feed-discovery");
  const result = await discoverFeeds("https://twitch.tv/example/videos", { locale: "de" });
  expect(result.feeds.map((f) => f.url)).toEqual(["feedferret://twitch/example/live", "feedferret://twitch/example/videos", "feedferret://twitch/example/clips"]);
  expect(result.feeds[0].title).toContain("Live-Status");
  expect(mocks.fetch.mock.calls.every(([url]) => url.startsWith("https://id.twitch.tv/") || url.startsWith("https://api.twitch.tv/"))).toBe(true);
});

it("shows setup guidance without Twitch credentials or RSSHub", async () => {
  mocks.settings.mockResolvedValue(null); mocks.decrypt.mockReturnValue(null);
  const { discoverFeeds } = await import("../../lib/feed-discovery");
  expect(await discoverFeeds("https://twitch.tv/example/clips")).toMatchObject({ feeds: [], hint: "needs-twitch" });
  expect(mocks.fetch).not.toHaveBeenCalled();
});

it("falls back to the existing RSSHub video route for every channel tab", async () => {
  mocks.settings.mockResolvedValue(null); mocks.decrypt.mockReturnValue(null);
  const rsshub = await import("../../lib/rsshub");
  const config = vi.spyOn(rsshub, "getRsshubConfig").mockResolvedValue({ baseUrl: "https://rsshub.example.com", apiKey: null });
  const validate = vi.spyOn(rsshub, "validateRsshubRoute").mockResolvedValue({ ok: true, title: "Example", itemCount: 1, sampleTitles: ["Synthetic"] });
  const { discoverFeeds } = await import("../../lib/feed-discovery");
  try {
    for (const suffix of ["", "/videos", "/clips"]) {
      const result = await discoverFeeds(`https://twitch.tv/example${suffix}`);
      expect(result.feeds[0].url).toBe("https://rsshub.example.com/twitch/video/example");
    }
  } finally { config.mockRestore(); validate.mockRestore(); }
});

it("renews tokens before expiry", async () => {
  const credentials = { clientId: "expiry-test", clientSecret: "secret" };
  mocks.fetch.mockReset().mockResolvedValueOnce(reply({ access_token: "short", expires_in: 1 })).mockResolvedValueOnce(reply({ data: [] })).mockResolvedValueOnce(reply({ access_token: "long", expires_in: 3600 })).mockResolvedValueOnce(reply({ data: [] }));
  await twitchRequest("users", {}, credentials);
  await twitchRequest("users", {}, credentials);
  expect(mocks.fetch.mock.calls.filter(([url]) => url.includes("oauth2/token"))).toHaveLength(2);
});

it("backs off on 429 and never surfaces OAuth error bodies", async () => {
  mocks.fetch.mockReset().mockResolvedValueOnce(reply({ access_token: "token", expires_in: 3600 })).mockResolvedValueOnce(reply({}, 429));
  const credentials = { clientId: "429-test", clientSecret: "secret" };
  await expect(twitchRequest("users", {}, credentials)).rejects.toThrow("429");
  expect(hostBackoffRemainingMs("https://api.twitch.tv")).toBeGreaterThan(0);
  resetHostBackoff();
  mocks.fetch.mockResolvedValueOnce(reply({ message: "SENSITIVE-OAUTH-BODY" }, 400));
  await expect(twitchRequest("users", {}, { clientId: "bad", clientSecret: "secret" })).rejects.toThrow("Twitch authentication failed");
});
