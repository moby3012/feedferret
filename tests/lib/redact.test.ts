import { expect, it } from "vitest";
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
