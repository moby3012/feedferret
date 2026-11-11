import { describe, expect, it } from "vitest";
import { cleanUrlInput, httpFallbackUrl, isConnectError, normalizeUrlInput } from "../../lib/url-input";
import { normalizeActionUrl, pageFetchErrorCode, sameFeedAddress } from "../../lib/add-feed-input";

describe("normalizeUrlInput", () => {
  it.each([
    ["chromie.de", "https://chromie.de/", true],
    ["  www.example.org/blog  ", "https://www.example.org/blog", true],
    ["example.com/feed.xml", "https://example.com/feed.xml", true],
    ["example.com:8080/x", "https://example.com:8080/x", true],
    ["127.0.0.1:4010/disc/site", "https://127.0.0.1:4010/disc/site", true],
    ["localhost:3000", "https://localhost:3000/", true],
    ["//cdn.example.net/rss", "https://cdn.example.net/rss", false],
    ["https://example.com/a?b=1#c", "https://example.com/a?b=1#c", false],
    ["HTTP://Example.COM", "http://example.com/", false],
    ["http:/example.com/feed", "http://example.com/feed", false],
    ["feed://example.com/atom.xml", "https://example.com/atom.xml", false],
    ["feed:https://example.com/rss", "https://example.com/rss", false],
    ["<https://example.com/feed>", "https://example.com/feed", false],
    ['"example.com/rss",', "https://example.com/rss", true],
    ["„beispiel.de/feed“", "https://beispiel.de/feed", true],
    ["example.com/feed.", "https://example.com/feed", true],
    ["https://en.wikipedia.org/wiki/Foo_(bar)", "https://en.wikipedia.org/wiki/Foo_(bar)", false],
    ["[My blog](https://blog.example.com/)", "https://blog.example.com/", false],
    ["​example.com ", "https://example.com/", true],
  ])("%j → %s", (input, url, schemeAssumed) => {
    expect(normalizeUrlInput(input)).toEqual({ ok: true, url, schemeAssumed });
  });

  it.each([
    ["", "url-empty"],
    ["   ", "url-empty"],
    [undefined, "url-empty"],
    ["local first software", "url-invalid"],
    ["not a url", "url-invalid"],
    ["(see example.com/feed).", "url-invalid"], // prose around an address is not guessed at
    ["justaword", "url-invalid"],
    ["ftp://example.com/feed", "url-unsupported-scheme"],
    ["javascript:alert(1)", "url-unsupported-scheme"],
    ["mailto:me@example.com", "url-unsupported-scheme"],
    [`https://example.com/${"a".repeat(2100)}`, "url-too-long"],
  ])("%j → %s", (input, code) => {
    expect(normalizeUrlInput(input)).toEqual({ ok: false, code });
  });
});

describe("cleanUrlInput", () => {
  it("strips wrappers and trailing punctuation but leaves phrases alone", () => {
    expect(cleanUrlInput("<https://x.dev/feed>")).toBe("https://x.dev/feed");
    expect(cleanUrlInput("example.com/feed.")).toBe("example.com/feed");
    expect(cleanUrlInput("  local first software  ")).toBe("local first software");
    expect(cleanUrlInput("@Gargron@mastodon.social")).toBe("@Gargron@mastodon.social");
  });
});

describe("http fallback helpers", () => {
  it("builds the http twin only for https URLs", () => {
    expect(httpFallbackUrl("https://a.example/x")).toBe("http://a.example/x");
    expect(httpFallbackUrl("http://a.example/x")).toBeNull();
  });

  it("retries only on connect-level failures", () => {
    expect(isConnectError(new Error("fetch failed"))).toBe(true);
    expect(isConnectError(new Error("Fetch failed: 403"))).toBe(false);
    expect(isConnectError(new Error("Feed hostname resolves to a private IP"))).toBe(false);
    expect(isConnectError(new Error("Response too large (5 bytes > 1 bytes)"))).toBe(false);
  });
});

describe("add-feed input plumbing", () => {
  it("normalizeActionUrl returns a code plus an English fallback text", () => {
    expect(normalizeActionUrl("chromie.de")).toEqual({ ok: true, url: "https://chromie.de/", schemeAssumed: true });
    const bad = normalizeActionUrl("nope nope");
    expect(bad).toMatchObject({ ok: false, errorCode: "url-invalid" });
    expect(bad.ok ? "" : bad.error).not.toMatch(/Invalid feed URL/);
  });

  it("maps page-fetch errors to stable codes", () => {
    expect(pageFetchErrorCode(new Error("Fetch failed: 403"))).toBe("page-blocked");
    expect(pageFetchErrorCode(new Error("Fetch failed: 402"))).toBe("page-blocked");
    expect(pageFetchErrorCode(new Error("Fetch failed: 404"))).toBe("page-not-found");
    expect(pageFetchErrorCode(new Error("Fetch failed: 429"))).toBe("page-rate-limited");
    expect(pageFetchErrorCode(new Error("Fetch failed: 500"))).toBe("page-http-error");
    expect(pageFetchErrorCode(new Error("AI feed config hostname resolves to a private IP"))).toBe("page-private-address");
    expect(pageFetchErrorCode(new Error("getaddrinfo ENOTFOUND"))).toBe("page-unreachable");
  });

  it("sameFeedAddress ignores scheme, host case and trailing slash", () => {
    expect(sameFeedAddress("https://Example.com/feed/", "http://example.com/feed")).toBe(true);
    expect(sameFeedAddress("https://example.com/feed", "https://example.com/rss")).toBe(false);
  });
});
