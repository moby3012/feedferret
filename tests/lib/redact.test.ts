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
    expect(redact("Authorization: Basic dXNlcjpwYXNz")).toBe("Authorization: Basic ***");
    expect(redact("headers={\"authorization\":\"x\"} Authorization: Bearer tok")).toBe("headers={\"authorization\":\"***\"} Authorization: Bearer ***");
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

  it("ends an unquoted value at whitespace, &, # or a quote; a comma belongs to the secret", () => {
    expect(redact("password=ab,cd")).toBe("password=***");
    expect(redact("token=abc def")).toBe("token=*** def");
    expect(redact("'token=abc'")).toBe("'token=***'");
    expect(redact("\"secret=abc\"")).toBe("\"secret=***\"");
    expect(redact("x=1&password=ab,cd&y=2")).toBe("x=1&password=***&y=2");
  });

  it("masks quoted values whole, keeping the quotes", () => {
    expect(redact('login password="hunter2" ok')).toBe('login password="***" ok');
    expect(redact("token='s3 cr3t,x' next")).toBe("token='***' next");
    expect(redact('password="a\\"hunter2" tail')).not.toContain("hunter2");
  });

  it("masks JSON properties with quoted keys and values", () => {
    const json = '{"password":"hunter2","user":"bob","Authorization":"Bearer abc.def","n":1}';
    const out = redact(json);
    expect(out).toBe('{"password":"***","user":"bob","Authorization":"Bearer ***","n":1}');
    expect(out).not.toContain("hunter2");
    expect(out).not.toContain("abc.def");
    expect(redact('{"access_token" : "tok123"}')).toBe('{"access_token" : "***"}');
  });

  it("consumes a whole Digest credential, quoted parameters included", () => {
    const header = 'Authorization: Digest username="alice", realm="corp", nonce="NONCE123", uri="/x", response="RESP456"';
    const out = redact(`${header}\nnext line`);
    expect(out).toBe("Authorization: Digest ***\nnext line");
    for (const secret of ["alice", "corp", "NONCE123", "RESP456"]) expect(out).not.toContain(secret);
  });

  it("masks the whole Cookie header line", () => {
    const out = redact("Cookie: session=SESS123; theme=dark\nHost: example.org");
    expect(out).toBe("Cookie: ***\nHost: example.org");
    expect(out).not.toContain("SESS123");
    expect(redact("Set-Cookie: sid=SIDVAL; Path=/")).not.toContain("SIDVAL");
  });

  it("keeps words that merely end in a secret word intact", () => {
    expect(redact("monkey=banana")).toBe("monkey=banana");
    expect(redact("oauth=shown&keyboard=us&author=bob")).toBe("oauth=shown&keyboard=us&author=bob");
    expect(redact("tokens=3 keyword=x")).toBe("tokens=3 keyword=x");
    expect(redact("Authority: example")).toBe("Authority: example");
  });

  it("still masks compound key names by their last segment", () => {
    expect(redact("x-api-key=AAA1 private_token=BBB2 client-secret=CCC3")).not.toMatch(/AAA1|BBB2|CCC3/);
    expect(redact("myapikey=DDD4")).toBe("myapikey=***");
  });

  it("masks sensitive properties of objects whatever their value", () => {
    const value = redactValue({
      password: "hunter2",
      config: { api_key: "k-123", "Set-Cookie": "sid=abc", nested: { refresh_token: "r-9" } },
      Authorization: "Basic dXNlcjpwYXNz",
      monkey: "banana",
      count: 3,
    }) as Record<string, any>;
    expect(value.password).toBe("***");
    expect(value.config.api_key).toBe("***");
    expect(value.config["Set-Cookie"]).toBe("***");
    expect(value.config.nested.refresh_token).toBe("***");
    expect(value.Authorization).toBe("***");
    expect(value.monkey).toBe("banana");
    expect(value.count).toBe(3);
    expect(JSON.stringify(value)).not.toMatch(/hunter2|k-123|sid=abc|r-9|dXNlcjpw/);
  });

  it("stays linear on long runs (no quadratic rescans of one key or header)", () => {
    const n = 200_000;
    for (const unit of ["a", "token", "auth:", "bearer ", "=", "a=", '"password":"', "Digest a=\"", "\\"]) {
      const text = unit.repeat(Math.ceil(n / unit.length)).slice(0, n);
      const t0 = performance.now();
      redact(text);
      expect(performance.now() - t0, unit).toBeLessThan(1_000);
    }
  });
});
