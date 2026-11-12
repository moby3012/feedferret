import { afterEach, describe, expect, it, vi } from "vitest";
import { validateAuthSecret } from "../../lib/auth-secret";
import { hasSyncSecret } from "../../lib/sync-auth";
import { getClientIdentifier } from "../../lib/rate-limit";

afterEach(() => { vi.unstubAllEnvs(); vi.restoreAllMocks(); });
describe("production secret", () => {
  it.each([undefined, "", "short", " YOUR-SUPER-SECRET-KEY-CHANGE-THIS "])("rejects insecure secret %s", secret => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    expect(() => validateAuthSecret(secret, true)).toThrow(/AUTH_SECRET/);
  });
  it("accepts placeholder substrings in otherwise long secrets", () => expect(() => validateAuthSecret("random-prefix-secret-with-enough-characters", true)).not.toThrow());
  it("accepts a long random value", () => expect(() => validateAuthSecret("a98F2u4kTn76Xz09QP56wB2m84ZvH7rL", true)).not.toThrow());
  it("does not enforce production policy in development", () => expect(() => validateAuthSecret("short", false)).not.toThrow());
});
describe("sync secret", () => {
  it("fails closed", () => {
    vi.stubEnv("SYNC_SECRET", "");
    expect(hasSyncSecret(new Request("https://example.test"))).toBe(false);
  });
  it("requires the full bearer value", () => {
    vi.stubEnv("SYNC_SECRET", "test-secret");
    for (const value of ["", "Bearer wrong", "Bearer test-secrex", "Bearer tést-secret"]) {
      expect(hasSyncSecret(new Request("https://example.test", { headers: { authorization: value } }))).toBe(false);
    }
    expect(hasSyncSecret(new Request("https://example.test", { headers: { authorization: "Bearer test-secret" } }))).toBe(true);
  });
});
describe("proxy chain", () => {
  const request = new Request("https://example.test", { headers: { "x-forwarded-for": "spoof, client, proxy" } });
  const behindProxy = new Request("https://example.test", { headers: { "x-forwarded-for": "spoof, client, proxy", "x-feedferret-peer": "guards-token|172.18.0.4" } });
  it("defaults to right-most (legacy mode, known private peer)", () => {
    vi.stubEnv("FEEDFERRET_PEER_TOKEN", "guards-token");
    vi.stubEnv("TRUSTED_PROXY_COUNT", "");
    vi.spyOn(console, "warn").mockImplementation(() => {});
    expect(getClientIdentifier(behindProxy)).toBe("ip:proxy");
  });
  it("selects configured hop", () => {
    vi.stubEnv("TRUSTED_PROXY_COUNT", "2");
    expect(getClientIdentifier(request)).toBe("ip:client");
  });
  it.each(["-1", "garbage", "1.5"])("invalid count %s fails to default", value => {
    vi.stubEnv("FEEDFERRET_PEER_TOKEN", "guards-token");
    vi.stubEnv("TRUSTED_PROXY_COUNT", value);
    vi.spyOn(console, "warn").mockImplementation(() => {});
    expect(getClientIdentifier(behindProxy)).toBe("ip:proxy");
  });
  it("an unset count without peer information keeps believing the header (legacy), so clients stay apart", () => {
    vi.stubEnv("TRUSTED_PROXY_COUNT", "");
    vi.spyOn(console, "warn").mockImplementation(() => {});
    expect(getClientIdentifier(request)).toBe("ip:proxy");
  });
});
