import { beforeEach, describe, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({ fetch: vi.fn(), settings: vi.fn(), decrypt: vi.fn() }));
vi.mock("@/lib/db", () => ({ db: { globalSettings: { findUnique: mocks.settings } } }));
vi.mock("@/lib/crypto", () => ({ decryptIfValue: mocks.decrypt }));
vi.mock("@/lib/ssrf", () => ({ safeFetch: mocks.fetch }));
import { fetchTwitchFeed, twitchRequest, getTwitchCredentials, getTwitchCredentialError, resetTwitchCaches } from "../../lib/twitch";
import { apiSourceAttentionCode, apiSourceAttentionReason, isApiSourceDeferredError } from "../../lib/api-source-errors";
import { fetchFeedArticles } from "../../lib/feed-fetcher";
import { hostBackoffRemainingMs, resetHostBackoff } from "../../lib/host-backoff";
import { canonicalApiSourceUrl, matchApiPlatform, parseApiSourceUrl } from "../../lib/feed-adapters/api-source-url";
import { normalizeUrlInput } from "../../lib/url-input";
import { validateFeedUrl } from "../../lib/validation";
import { generateOpml, parseOpml } from "../../lib/opml";
const reply = (data: unknown, status = 200, headers = {}) => new Response(JSON.stringify(data), { status, headers });
let sequence = 0;
beforeEach(() => {
  vi.clearAllMocks(); resetHostBackoff(); resetTwitchCaches();
  mocks.settings.mockResolvedValue({ twitchClientId: `synthetic-${++sequence}`, twitchClientSecret: "sealed" });
  mocks.decrypt.mockReturnValue("synthetic-secret");
  mocks.fetch.mockImplementation(async (url: string) => url.includes("oauth2/token") ? reply({ access_token: "synthetic-token", expires_in: 3600 }) : url.includes("/users?") ? reply({ data: [{ id: "123", display_name: "Example" }] }) : reply({ data: [] }));
});
describe("official Twitch API platform source", () => {
  it.each(["", "/videos", "/clips"])("matches channel route %s and offers registered variants", (suffix) => {
    expect(matchApiPlatform(new URL(`https://www.twitch.tv/example${suffix}`))?.source.variants.map((v) => v.id)).toEqual(["live", "videos", "clips"]);
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
  it("imports mixed-case OPML URLs with the same identity as a native subscription", async () => {
    const { planOpmlImport } = await import("../../lib/import/opml-import");
    const outlines = await parseOpml(generateOpml([{ name: "Synthetic", url: "FEEDFERRET://Twitch/Example/LIVE" }]));
    const plan = planOpmlImport(outlines);
    expect(plan.errors).toEqual([]);
    expect(plan.feeds[0].url).toBe("feedferret://twitch/example/live");
    expect(plan.feeds[0].url).toBe(canonicalApiSourceUrl("feedferret://twitch/example/live"));
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
    const error = await fetchTwitchFeed("example", "live").catch((e) => e);
    expect(error.message).toContain("Server settings");
    // Typed so syncFeed defers instead of counting a feed failure (no auto-mute).
    expect(isApiSourceDeferredError(error) && error.reason).toBe("unconfigured");
    expect(mocks.fetch).not.toHaveBeenCalled();
  });
  it("decrypts the stored secret with the globalSettings.twitchClientSecret purpose", async () => {
    mocks.settings.mockResolvedValue({ twitchClientId: "id", twitchClientSecret: "sealed-value" });
    mocks.decrypt.mockReturnValue("plain");
    expect(await getTwitchCredentials()).toEqual({ clientId: "id", clientSecret: "plain" });
    expect(mocks.decrypt).toHaveBeenCalledWith("sealed-value", "globalSettings.twitchClientSecret");
  });
  it("mints one token for N concurrent requests and never uses a caller's abort signal", async () => {
    const creds = { clientId: "single-flight", clientSecret: "secret" };
    const first = new AbortController();
    const transport = mocks.fetch.getMockImplementation()!;
    // Honor cancellation on Helix requests so the joining callers prove that
    // an aborted leader cannot cancel their shared token mint.
    mocks.fetch.mockImplementation(async (url: string, init: RequestInit) => {
      init.signal?.throwIfAborted();
      return transport(url, init);
    });
    const calls = Promise.allSettled([twitchRequest("users", {}, creds, first.signal), ...Array.from({ length: 4 }, () => twitchRequest("users", {}, creds))]);
    first.abort();
    const results = await calls;
    expect(results[0].status).toBe("rejected");
    expect(results.slice(1).every((r) => r.status === "fulfilled")).toBe(true);
    const tokens = mocks.fetch.mock.calls.filter(([url]) => url.includes("oauth2/token"));
    expect(tokens).toHaveLength(1);
    expect(tokens[0][1].signal).not.toBe(first.signal);
    expect(tokens[0][1].signal.aborted).toBe(false);
    await expect(Promise.all(Array.from({ length: 3 }, () => twitchRequest("users", {}, creds)))).resolves.toHaveLength(3);
    expect(mocks.fetch.mock.calls.filter(([url]) => url.includes("oauth2/token"))).toHaveLength(1);
  });
  it("on 401 drops the cached token only if it is the one that was rejected", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    try {
      const creds = { clientId: "stale-401", clientSecret: "secret" };
      let tokenCount = 0;
      const auth: string[] = [];
      mocks.fetch.mockImplementation(async (url: string, init: { headers?: Record<string, string> }) => {
        if (url.includes("oauth2/token")) return reply({ access_token: ++tokenCount === 1 ? "old" : "new", expires_in: 3600 });
        auth.push(init.headers!.Authorization);
        if (auth.length === 1) {
          // While request A is in flight with "old", the clock passes its expiry
          // and a concurrent request B mints and caches "new".
          vi.setSystemTime(Date.now() + 3600_000);
          await twitchRequest("users", {}, creds);
          return reply({}, 401);
        }
        return reply({ data: [] });
      });
      await twitchRequest("users", {}, creds);
      expect(tokenCount).toBe(2); // "old" and B's "new"; A's retry reused the cache
      expect(auth).toEqual(["Bearer old", "Bearer new", "Bearer new"]);
    } finally { vi.useRealTimers(); }
  });
  it("negative-caches a failed token mint per credential and defers instead of failing", async () => {
    mocks.fetch.mockImplementation(async (url: string) => url.includes("oauth2/token") ? reply({ message: "SENSITIVE-OAUTH-BODY" }, 400) : reply({ data: [] }));
    const bad = { clientId: "bad-mint", clientSecret: "secret" };
    const errors = [];
    for (let i = 0; i < 3; i++) errors.push(await twitchRequest("users", {}, bad).catch((e) => e));
    expect(errors.every((e) => isApiSourceDeferredError(e) && e.reason === "auth")).toBe(true);
    expect(errors.map((e) => e.status)).toEqual([400, 400, 400]);
    expect(String(errors[0].message)).not.toContain("SENSITIVE");
    expect(mocks.fetch.mock.calls.filter(([url]) => url.includes("oauth2/token"))).toHaveLength(1);
    // Other (e.g. just corrected) credentials are not blocked by the failure.
    await twitchRequest("users", {}, { clientId: "bad-mint-fixed", clientSecret: "secret" }).catch(() => undefined);
    expect(mocks.fetch.mock.calls.filter(([url]) => url.includes("oauth2/token"))).toHaveLength(2);
  });
  it.each([[400, "auth"], [401, "auth"], [403, "auth"], [429, "rate-limited"]])("classifies a %i from the token endpoint as %s", async (status, reason) => {
    mocks.fetch.mockImplementation(async (url: string) => url.includes("oauth2/token") ? reply({}, status) : reply({ data: [] }));
    const error = await twitchRequest("users", {}, { clientId: `classify-${status}`, clientSecret: "secret" }).catch((e) => e);
    expect(isApiSourceDeferredError(error) && error.reason).toBe(reason);
    expect(error.status).toBe(status);
    if (reason === "rate-limited") expect(error.retryAfterMs).toBeGreaterThan(0);
  });
  it.each([
    ["a 500", () => reply({}, 500)],
    ["a 503", () => reply({}, 503)],
    ["a network error", () => { throw new TypeError("fetch failed"); }],
    ["a timeout", () => { throw new DOMException("timed out", "TimeoutError"); }],
    ["an invalid body", () => reply({ nope: true })],
  ])("treats %s while minting as transient: no auth wording, no negative cache, no credential error", async (_name, answer) => {
    mocks.fetch.mockImplementation(async (url: string) => url.includes("oauth2/token") ? answer() : reply({ data: [] }));
    const creds = { clientId: "transient-mint", clientSecret: "secret" };
    const errors = [];
    for (let i = 0; i < 3; i++) errors.push(await twitchRequest("users", {}, creds).catch((e) => e));
    expect(errors.every((e) => isApiSourceDeferredError(e) && e.reason === "transient")).toBe(true);
    expect(String(errors[0].message)).not.toMatch(/Client ID|authentication/i);
    expect(mocks.fetch.mock.calls.filter(([url]) => url.includes("oauth2/token"))).toHaveLength(3);
    expect(getTwitchCredentialError()).toBeNull();
  });
  it("records the last credential rejection (process-level) and clears it after a successful mint", async () => {
    expect(getTwitchCredentialError()).toBeNull();
    mocks.fetch.mockImplementation(async (url: string) => url.includes("oauth2/token") ? reply({}, 401) : reply({ data: [] }));
    await twitchRequest("users", {}, { clientId: "rejected", clientSecret: "secret" }).catch(() => undefined);
    const recorded = getTwitchCredentialError();
    expect(recorded?.status).toBe(401);
    expect(Number.isFinite(Date.parse(recorded!.at))).toBe(true);
    // Ephemeral admin tests never write it.
    resetTwitchCaches();
    await twitchRequest("users", {}, { clientId: "rejected-test", clientSecret: "secret" }, undefined, { ephemeral: true }).catch(() => undefined);
    expect(getTwitchCredentialError()).toBeNull();
    mocks.fetch.mockImplementation(async (url: string) => url.includes("oauth2/token") ? reply({}, 401) : reply({ data: [] }));
    await twitchRequest("users", {}, { clientId: "rejected", clientSecret: "secret" }).catch(() => undefined);
    expect(getTwitchCredentialError()).not.toBeNull();
    mocks.fetch.mockImplementation(async (url: string) => url.includes("oauth2/token") ? reply({ access_token: "ok", expires_in: 3600 }) : reply({ data: [] }));
    await twitchRequest("users", {}, { clientId: "fixed", clientSecret: "secret" });
    expect(getTwitchCredentialError()).toBeNull();
  });
  it("exposes the remaining backoff on a rate-limit deferral", async () => {
    const creds = { clientId: "retry-after", clientSecret: "secret" };
    mocks.fetch.mockReset().mockResolvedValueOnce(reply({ access_token: "token", expires_in: 3600 })).mockResolvedValueOnce(reply({}, 429, { "Ratelimit-Reset": String(Math.ceil(Date.now() / 1000) + 120) }));
    const first = await twitchRequest("users", {}, creds).catch((e) => e);
    expect(first.retryAfterMs).toBeGreaterThan(100_000);
    const second = await twitchRequest("users", {}, creds).catch((e) => e);
    expect(second.retryAfterMs).toBeGreaterThan(100_000);
  });
  it("encodes the feed attention status as a code the UI maps back", () => {
    expect(apiSourceAttentionReason({ lastStatus: "attention", lastError: apiSourceAttentionCode("auth") })).toBe("auth");
    expect(apiSourceAttentionReason({ lastStatus: "attention", lastError: apiSourceAttentionCode("unconfigured") })).toBe("unconfigured");
    for (const feed of [{ lastStatus: "error", lastError: "api-source:auth" }, { lastStatus: "attention", lastError: "boom" }, { lastStatus: "ok", lastError: null }, {}]) {
      expect(apiSourceAttentionReason(feed)).toBeNull();
    }
  });
  it("ephemeral (connection-test) requests never touch the shared token or failure caches", async () => {
    const creds = { clientId: "ephemeral", clientSecret: "secret" };
    await twitchRequest("users", {}, creds, undefined, { ephemeral: true });
    await twitchRequest("users", {}, creds, undefined, { ephemeral: true });
    await twitchRequest("users", {}, creds);
    expect(mocks.fetch.mock.calls.filter(([url]) => url.includes("oauth2/token"))).toHaveLength(3);
    mocks.fetch.mockImplementation(async (url: string) => url.includes("oauth2/token") ? reply({}, 401) : reply({ data: [] }));
    const bad = { clientId: "ephemeral-bad", clientSecret: "secret" };
    await twitchRequest("users", {}, bad, undefined, { ephemeral: true }).catch(() => undefined);
    await twitchRequest("users", {}, bad, undefined, { ephemeral: true }).catch(() => undefined);
    expect(mocks.fetch.mock.calls.filter(([url]) => url.includes("oauth2/token"))).toHaveLength(5);
  });
  it("defers (typed) on rate limit and on a 429 answer", async () => {
    const creds = { clientId: "typed-429", clientSecret: "secret" };
    mocks.fetch.mockReset().mockResolvedValueOnce(reply({ access_token: "token", expires_in: 3600 })).mockResolvedValueOnce(reply({}, 429));
    const hit = await twitchRequest("users", {}, creds).catch((e) => e);
    expect(isApiSourceDeferredError(hit) && hit.reason).toBe("rate-limited");
    const blocked = await twitchRequest("users", {}, creds).catch((e) => e);
    expect(isApiSourceDeferredError(blocked) && blocked.reason).toBe("rate-limited");
  });
  it("caches login → user id so repeated polls skip the users lookup", async () => {
    resetTwitchCaches();
    await fetchTwitchFeed("cacheme", "live");
    await fetchTwitchFeed("cacheme", "videos");
    expect(mocks.fetch.mock.calls.filter(([url]) => url.includes("/users?"))).toHaveLength(1);
  });
  it("canonicalises internal URLs and dispatches mixed-case ones to the API provider", async () => {
    expect(canonicalApiSourceUrl("FEEDFERRET://Twitch/Example/LIVE")).toBe("feedferret://twitch/example/live");
    expect(canonicalApiSourceUrl("feedferret://twitch/example/live?x=1")).toBeNull();
    expect(normalizeUrlInput("FEEDFERRET://twitch/Example/Live")).toMatchObject({ ok: true, url: "feedferret://twitch/example/live" });
    expect(validateFeedUrl("FEEDFERRET://twitch/Example/Live")).toBeNull();
    const feed = await fetchFeedArticles({ url: "FEEDFERRET://twitch/Example/live" } as Parameters<typeof fetchFeedArticles>[0]);
    expect(feed.articles).toEqual([]);
    expect(mocks.fetch.mock.calls.some(([url]) => url.includes("/streams?"))).toBe(true);
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
  expect(await discoverFeeds("https://twitch.tv/example/clips")).toMatchObject({ feeds: [], hint: "needs-api-credentials", hintPlatform: "Twitch" });
  expect(mocks.fetch).not.toHaveBeenCalled();
});

it("rejected credentials give setup guidance and still try the RSSHub fallback", async () => {
  mocks.fetch.mockImplementation(async (url: string) => url.includes("oauth2/token") ? reply({}, 400) : reply({ data: [] }));
  const { discoverFeeds } = await import("../../lib/feed-discovery");
  expect(await discoverFeeds("https://twitch.tv/example")).toMatchObject({ feeds: [], hint: "needs-api-credentials", hintPlatform: "Twitch" });
  const rsshub = await import("../../lib/rsshub");
  const config = vi.spyOn(rsshub, "getRsshubConfig").mockResolvedValue({ baseUrl: "https://rsshub.example.com", apiKey: null });
  const validate = vi.spyOn(rsshub, "validateRsshubRoute").mockResolvedValue({ ok: true, title: "Example", itemCount: 1, sampleTitles: ["Synthetic"] });
  try {
    resetTwitchCaches();
    expect((await discoverFeeds("https://twitch.tv/example")).feeds[0].url).toBe("https://rsshub.example.com/twitch/video/example");
  } finally { config.mockRestore(); validate.mockRestore(); }
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
