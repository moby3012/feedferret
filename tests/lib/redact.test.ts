import { describe, expect, it } from "vitest";
import { redact, redactValue } from "../../lib/redact";
it("scrubs URL credentials and all sensitive query names", () => {
  for (const key of ["key", "token", "access_key", "api_key", "apikey", "password", "secret", "TOKEN"]) {
    expect(redact(`failed https://user:pass@example.com/rss?${key}=hidden&ok=yes`)).toBe(`failed https://***@example.com/rss?${key}=***&ok=yes`);
  }
  expect((redactValue(new Error("https://a.test/?key=hidden")) as Error).message).not.toContain("hidden");
});
it("handles suffix names, delimiters, encoded URLs and arbitrary schemes", () => {
  for (const key of ["access_token", "auth", "sig", "pwd", "client_secret", "private_token", "api-key", "x-api-key"]) {
    for (const delimiter of ["?", "#", ";", "&amp;"]) expect(redact(`${delimiter}${key}=hidden`)).toBe(`${delimiter}${key}=***`);
    expect(redact(`%3F${key}%3Dhidden%26ok%3Dyes`)).toBe(`%3F${key}%3D***%26ok%3Dyes`);
  }
  for (const scheme of ["postgresql", "socks5", "ftp"]) expect(redact(`${scheme}://u:p@ss@h/path`)).toBe(`${scheme}://***@h/path`);
  expect(redact("https://h/?x=a@b.com")).toBe("https://h/?x=a@b.com");
});
it("preserves special objects, errors and shared DAG nodes while bounding cycles", () => {
  for (const v of [new Date(), new URL("https://example.com"), new Map(), new Set(), Buffer.from("x")]) expect(redactValue(v)).toBe(v);
  const shared = { message: "?key=hidden" };
  expect(redactValue({ a: shared, b: shared })).toEqual({ a: { message: "?key=***" }, b: { message: "?key=***" } });
  const err = Object.assign(new Error("?token=hidden", { cause: new Error("?pwd=hidden") }), { custom: shared });
  const copy = redactValue(err) as typeof err;
  expect(copy).toBeInstanceOf(Error);
  expect(copy.message).toBe("?token=***");
  expect((copy.cause as Error).message).toBe("?pwd=***");
  expect(copy.custom.message).toBe("?key=***");
  const cycle: Record<string, unknown> = {}; cycle.self = cycle;
  expect(redactValue(cycle)).toEqual({ self: "[Circular]" });
  expect(JSON.stringify(redactValue(Array.from({ length: 2000 }, () => shared))).length).toBeLessThan(40000);
});

describe("secret pairs outside query strings (authorization=…, Authorization: …, bare key=value)", () => {
  it("masks authorization=… with or without a scheme, in any letter case", () => {
    expect(redact("GET /x authorization=Bearer abc.def-123&a=1")).toBe("GET /x authorization=Bearer ***&a=1");
    expect(redact("authorization=xyz")).toBe("authorization=***");
    expect(redact("AUTHORIZATION=Basic dXNlcjpwYXNz")).toBe("AUTHORIZATION=Basic ***");
    expect(redact("Proxy-Authorization=Digest a=b")).toBe("Proxy-Authorization=Digest ***");
  });

  it("masks Authorization headers written as text, keeping the scheme", () => {
    expect(redact("Authorization: Basic dXNlcjpwYXNz rest of line")).toBe("Authorization: Basic *** rest of line");
    expect(redact("headers={\"authorization\":\"x\"} Authorization: Bearer tok")).toBe("headers={\"authorization\":\"x\"} Authorization: Bearer ***");
    expect(redact("Proxy-Authorization:Bearer  t")).toBe("Proxy-Authorization:Bearer  ***");
  });

  it("masks access_token, api_key, apikey, token and password pairs in plain text", () => {
    expect(redact("retry access_token=abc&x=1")).toBe("retry access_token=***&x=1");
    expect(redact("api_key=AKIA123 next")).toBe("api_key=*** next");
    expect(redact("apikey=zz")).toBe("apikey=***");
    expect(redact("token=")).toBe("token=***");
    expect(redact("db connect password=hunter2 host=db")).toBe("db connect password=*** host=db");
    expect(redact("https://h.test/feed?password=p%20w#frag")).toBe("https://h.test/feed?password=***#frag");
  });

  it("ends the value at & whitespace, quotes and commas", () => {
    expect(redact("token=abc,def")).toBe("token=***,def");
    expect(redact("token=abc def")).toBe("token=*** def");
    expect(redact("'token=abc'")).toBe("'token=***'");
    expect(redact("\"secret=abc\"")).toBe("\"secret=***\"");
  });

  it("leaves unrelated keys alone and does not treat a key inside a longer word as a boundary match", () => {
    expect(redact("author=bob&theme=dark&keyboard=us")).toBe("author=bob&theme=dark&keyboard=us");
    expect(redact("aaaa=bbbb")).toBe("aaaa=bbbb");
    expect(redact("Authority: example")).toBe("Authority: example");
  });

  it("stays linear on long runs (no quadratic rescans of one key or header)", () => {
    const n = 200_000;
    for (const unit of ["a", "token", "auth:", "bearer ", "=", "a="]) {
      const text = unit.repeat(Math.ceil(n / unit.length)).slice(0, n);
      const t0 = performance.now();
      redact(text);
      expect(performance.now() - t0, unit).toBeLessThan(1_000);
    }
  });
});
