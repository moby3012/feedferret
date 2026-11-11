import { describe, expect, it } from "vitest";
import { classifyFetchFailure, cleanUrlInput, httpFallbackUrl, isConnectError, isTlsError, normalizeUrlInput } from "../../lib/url-input";
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

  /** undici's shape: `TypeError: fetch failed` with the real error in `cause`. */
  const wrapped = (code: string, message: string) => new TypeError("fetch failed", { cause: Object.assign(new Error(message), { code }) });
  const bare = (code: string, message: string) => Object.assign(new Error(message), { code });

  it.each([
    ["ECONNREFUSED", "connect ECONNREFUSED 1.2.3.4:443"],
    ["EHOSTUNREACH", "connect EHOSTUNREACH"],
    ["ENETUNREACH", "connect ENETUNREACH"],
    ["ETIMEDOUT", "connect ETIMEDOUT"],
    ["UND_ERR_CONNECT_TIMEOUT", "Connect Timeout Error"],
  ])("allows the http retry only for connection-level %s (wrapped and bare)", (code, message) => {
    expect(isConnectError(wrapped(code, message))).toBe(true);
    expect(isConnectError(bare(code, message))).toBe(true);
  });

  it.each([
    ["DEPTH_ZERO_SELF_SIGNED_CERT", "self-signed certificate"],
    ["SELF_SIGNED_CERT_IN_CHAIN", "self-signed certificate in certificate chain"],
    ["CERT_HAS_EXPIRED", "certificate has expired"],
    ["ERR_TLS_CERT_ALTNAME_INVALID", "Hostname/IP does not match certificate's altnames"],
    ["UNABLE_TO_VERIFY_LEAF_SIGNATURE", "unable to verify the first certificate"],
    ["UNABLE_TO_GET_ISSUER_CERT_LOCALLY", "unable to get local issuer certificate"],
    ["ERR_SSL_WRONG_VERSION_NUMBER", "error:0A00010B:SSL routines::wrong version number"],
    ["EPROTO", "write EPROTO"],
    ["ECONNRESET", "Client network socket disconnected before secure TLS connection was established"],
  ])("never retries over http after a TLS/certificate failure: %s", (code, message) => {
    for (const err of [wrapped(code, message), bare(code, message), new AggregateError([wrapped(code, message)], "x")]) {
      expect(classifyFetchFailure(err)).toBe("tls");
      expect(isConnectError(err)).toBe(false);
      expect(isTlsError(err)).toBe(true);
    }
    // TLS wins even when a connect code is also somewhere in the chain.
    const mixed = new TypeError("fetch failed", { cause: Object.assign(new Error("connect ETIMEDOUT"), { code: "ETIMEDOUT", cause: bare(code, message) }) });
    expect(isConnectError(mixed)).toBe(false);
  });

  it("unknown errors, status errors, SSRF refusals, DNS and resets never qualify", () => {
    expect(isConnectError(new TypeError("fetch failed"))).toBe(false);
    expect(isConnectError(new Error("something odd"))).toBe(false);
    expect(isConnectError(new Error("Fetch failed: 403"))).toBe(false);
    expect(isConnectError(new Error("Feed hostname resolves to a private IP"))).toBe(false);
    expect(isConnectError(wrapped("ENOTFOUND", "getaddrinfo ENOTFOUND x.example"))).toBe(false);
    expect(isConnectError(wrapped("ECONNRESET", "read ECONNRESET"))).toBe(false);
    expect(isConnectError(Object.assign(new Error("aborted"), { name: "AbortError" }))).toBe(false);
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
    expect(pageFetchErrorCode(new TypeError("fetch failed", { cause: Object.assign(new Error("certificate has expired"), { code: "CERT_HAS_EXPIRED" }) }))).toBe("page-tls-error");
  });

  it("sameFeedAddress ignores scheme, host case and trailing slash", () => {
    expect(sameFeedAddress("https://Example.com/feed/", "http://example.com/feed")).toBe(true);
    expect(sameFeedAddress("https://example.com/feed", "https://example.com/rss")).toBe(false);
  });
});
