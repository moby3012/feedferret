import { describe, it, expect } from "vitest";
import { generateApiToken, hashApiToken } from "../../lib/token";

describe("generateApiToken", () => {
  it("has the ff_ prefix", () => {
    const { raw } = generateApiToken();
    expect(raw.startsWith("ff_")).toBe(true);
  });

  it("base64url-encodes 32 bytes after the prefix", () => {
    const { raw } = generateApiToken();
    const encoded = raw.slice(3);
    // 32 bytes in base64url = ceil(32/3)*4 = 44 chars (with padding stripped = 43)
    expect(encoded.length).toBeGreaterThanOrEqual(42);
    expect(encoded.length).toBeLessThanOrEqual(44);
    expect(/^[A-Za-z0-9_-]+$/.test(encoded)).toBe(true);
  });

  it("two calls produce different tokens", () => {
    const a = generateApiToken();
    const b = generateApiToken();
    expect(a.raw).not.toBe(b.raw);
    expect(a.hash).not.toBe(b.hash);
  });
});

describe("hashApiToken", () => {
  it("is deterministic", () => {
    const token = "ff_test_token";
    expect(hashApiToken(token)).toBe(hashApiToken(token));
  });

  it("produces a hex SHA-256 digest (64 chars)", () => {
    const { hash } = generateApiToken();
    expect(hash).toHaveLength(64);
    expect(/^[0-9a-f]+$/.test(hash)).toBe(true);
  });

  it("different tokens produce different hashes", () => {
    const a = generateApiToken();
    const b = generateApiToken();
    expect(a.hash).not.toBe(b.hash);
  });

  it("raw token hash matches stored hash", () => {
    const { raw, hash } = generateApiToken();
    expect(hashApiToken(raw)).toBe(hash);
  });
});
