// M8 PR 4 (security audit #2): v2 secret box — read-only release.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  SECRET_COLUMNS,
  SecretKeyError,
  WEBHOOK_HEADER_PURPOSE,
  WEBHOOK_SECRET_PURPOSE,
  classifySecret,
  deriveMacKey,
  keyId,
  loadKeyring,
  openSecret as openCore,
  sealV2,
} from "../../lib/secret-box-core.mjs";
import { getKeyring, openSecret, readPlainColumn, readPlainColumnOrNull, sealSecret, verifyMac, hmacHex } from "../../lib/secret-box";
import { decryptIfValue, encrypt } from "../../lib/crypto";
import { validateEncryptionKey } from "../../lib/auth-secret";

const AUTH_A = "auth-secret-A-with-enough-random-characters-0001";
const AUTH_B = "auth-secret-B-with-enough-random-characters-0002";
const ENC_KEY = Buffer.alloc(32, 7).toString("base64");
const ENV_KEYS = ["AUTH_SECRET", "FEEDFERRET_ENCRYPTION_KEY", "FEEDFERRET_ENCRYPTION_KEYS_OLD", "NEXT_PHASE"] as const;
const saved: Record<string, string | undefined> = {};

function setEnv(env: Partial<Record<(typeof ENV_KEYS)[number], string>>) {
  for (const key of ENV_KEYS) {
    if (env[key] === undefined) delete process.env[key];
    else process.env[key] = env[key];
  }
}

beforeEach(() => {
  for (const key of ENV_KEYS) saved[key] = process.env[key];
  setEnv({ AUTH_SECRET: AUTH_A });
});
afterEach(() => {
  for (const key of ENV_KEYS) {
    if (saved[key] === undefined) delete process.env[key];
    else process.env[key] = saved[key];
  }
  vi.restoreAllMocks();
});

const ALL_PURPOSES = [...SECRET_COLUMNS.map((c) => c.purpose), WEBHOOK_SECRET_PURPOSE, WEBHOOK_HEADER_PURPOSE];

describe("secret box v2 format", () => {
  it.each(ALL_PURPOSES)("round-trips %s in v2 and in its legacy format", (purpose) => {
    const column = SECRET_COLUMNS.find((c) => c.purpose === purpose);
    const legacy = column?.legacy ?? "plaintext";
    const plaintext = `value:for:${purpose}:{"json":true}`;

    const sealed = sealSecret(purpose, plaintext);
    expect(sealed).toMatch(/^ff2\.[0-9a-f]{8}\.[A-Za-z0-9_-]{16}\.[A-Za-z0-9_-]+$/);
    expect(sealed).not.toContain(plaintext);
    expect(openSecret(purpose, sealed, legacy)).toEqual({ value: plaintext, stale: false, format: "v2", kid: getKeyring().current.kid });

    const old = legacy === "v1" ? encrypt(plaintext) : plaintext;
    expect(openSecret(purpose, old, legacy)).toMatchObject({ value: plaintext, stale: true, format: legacy });
  });

  it("binds a ciphertext to its column (purpose is HKDF info and GCM AAD)", () => {
    const sealed = sealSecret("feed.authPassword", "pw");
    expect(() => openSecret("user.twoFactorSecret", sealed, "plaintext")).toThrow(SecretKeyError);
    try {
      openSecret("user.twoFactorSecret", sealed, "plaintext");
    } catch (error) {
      expect((error as SecretKeyError).reason).toBe("wrong-key");
      expect((error as Error).message).not.toContain("pw");
    }
  });

  it("detects tampering", () => {
    const sealed = sealSecret("user.gotifyToken", "token-value");
    const last = sealed.at(-1) === "A" ? "B" : "A";
    expect(() => openSecret("user.gotifyToken", sealed.slice(0, -1) + last, "plaintext")).toThrow(SecretKeyError);
  });

  it("never parses previously-plaintext columns as v1 (passwords and JSON contain colons)", () => {
    const lookalike = "YWJj:ZGVm:Z2hp"; // matches the v1 shape
    expect(openSecret("feed.authPassword", lookalike, "plaintext")).toMatchObject({ value: lookalike, format: "plaintext" });
    const json = JSON.stringify({ CURLOPT_PROXY: "http://u:p@proxy:8080" });
    expect(openSecret("feed.httpOptions", json, "plaintext").value).toBe(json);
  });

  it("plaintext reads need no key at all", () => {
    setEnv({});
    expect(readPlainColumn("user.ntfyToken", "plain-token")).toBe("plain-token");
    expect(readPlainColumn("user.ntfyToken", null)).toBeNull();
    expect(readPlainColumn("user.ntfyToken", "")).toBeNull();
  });

  it("rotation: an old key in FEEDFERRET_ENCRYPTION_KEYS_OLD still opens (stale), a missing one is a clear error", () => {
    const sealedUnderA = sealSecret("user.twoFactorSecret", "JBSWY3DPEHPK3PXP");
    const kidA = getKeyring().current.kid;

    setEnv({ AUTH_SECRET: AUTH_A, FEEDFERRET_ENCRYPTION_KEY: ENC_KEY, FEEDFERRET_ENCRYPTION_KEYS_OLD: AUTH_A });
    expect(getKeyring().current.kid).not.toBe(kidA);
    expect(openSecret("user.twoFactorSecret", sealedUnderA, "plaintext")).toMatchObject({ value: "JBSWY3DPEHPK3PXP", stale: true, kid: kidA });

    setEnv({ AUTH_SECRET: AUTH_B });
    let caught: unknown;
    try {
      openSecret("user.twoFactorSecret", sealedUnderA, "plaintext");
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(SecretKeyError);
    expect((caught as SecretKeyError).reason).toBe("unknown-kid");
    expect((caught as Error).message).toContain(kidA);
    expect((caught as Error).message).toContain("FEEDFERRET_ENCRYPTION_KEYS_OLD");
    expect((caught as Error).message).not.toContain("JBSWY3DPEHPK3PXP");
  });

  it("FEEDFERRET_ENCRYPTION_KEY wins over AUTH_SECRET; moving a value to _OLD keeps its key id", () => {
    setEnv({ AUTH_SECRET: AUTH_A, FEEDFERRET_ENCRYPTION_KEY: ENC_KEY });
    const ring = loadKeyring(process.env);
    expect(ring.current.source).toBe("FEEDFERRET_ENCRYPTION_KEY");
    expect(ring.current.kid).toBe(keyId(Buffer.from(ENC_KEY)));
    const moved = loadKeyring({ AUTH_SECRET: AUTH_B, FEEDFERRET_ENCRYPTION_KEYS_OLD: ` ${ENC_KEY} , ` });
    expect(moved.old.map((k) => k.kid)).toEqual([ring.current.kid]);
  });

  it("v1 values stay readable after AUTH_SECRET rotation when the old secret is in _OLD", () => {
    const v1 = encrypt("sk-ai-key");
    setEnv({ AUTH_SECRET: AUTH_B, FEEDFERRET_ENCRYPTION_KEYS_OLD: AUTH_A });
    expect(decryptIfValue(v1, "user.aiApiKey")).toBe("sk-ai-key");
  });

  it("decryptIfValue: wrong key → null, logged once per column without the value", () => {
    const v1 = encrypt("sk-secret-value");
    const sealed = sealSecret("user.aiApiKey", "sk-secret-value");
    setEnv({ AUTH_SECRET: AUTH_B });
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    expect(decryptIfValue(v1, "user.contentFetchApiKey")).toBeNull();
    expect(decryptIfValue(v1, "user.contentFetchApiKey")).toBeNull();
    expect(decryptIfValue(sealed, "user.aiApiKey")).toBeNull();
    expect(warn).toHaveBeenCalledTimes(2);
    expect(JSON.stringify(warn.mock.calls)).not.toContain("sk-secret-value");
  });

  it("readPlainColumnOrNull returns null for an undecryptable value instead of throwing", () => {
    const sealed = sealSecret("user.telegramBotToken", "123:abc");
    setEnv({ AUTH_SECRET: AUTH_B });
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    expect(() => readPlainColumn("user.telegramBotToken", sealed)).toThrow(SecretKeyError);
    expect(readPlainColumnOrNull("user.telegramBotToken", sealed)).toBeNull();
  });

  it("refuses to seal during the production build", () => {
    setEnv({ NEXT_PHASE: "phase-production-build" });
    expect(() => sealV2("user.aiApiKey", "x", loadKeyring(process.env))).toThrow(/build/);
  });

  it("missing keys for an encrypted value is a clear error", () => {
    const sealed = sealSecret("user.aiApiKey", "x");
    expect(() => openCore("user.aiApiKey", sealed, { legacy: "v1", keyring: () => loadKeyring({}) })).toThrow(/FEEDFERRET_ENCRYPTION_KEY or AUTH_SECRET/);
  });

  it("classifySecret buckets values without exposing them", () => {
    const ring = loadKeyring(process.env);
    const column = { purpose: "user.aiApiKey", legacy: "v1" as const };
    expect(classifySecret(null, column, ring)).toBe("empty");
    expect(classifySecret(encrypt("k"), column, ring)).toBe("v1");
    expect(classifySecret(sealSecret("user.aiApiKey", "k"), column, ring)).toBe(`v2:${ring.current.kid}:current`);
    expect(classifySecret("garbage", column, ring)).toBe("undecryptable");
    expect(classifySecret("plain", { purpose: "feed.authPassword", legacy: "plaintext" }, ring)).toBe("plaintext");
    const other = loadKeyring({ AUTH_SECRET: AUTH_B });
    expect(classifySecret(sealSecret("user.aiApiKey", "k"), column, other)).toMatch(/^v2:[0-9a-f]{8}:unknown$/);
  });
});

describe("HMAC domain separation (dual verify, legacy issue)", () => {
  it("accepts the legacy raw-secret MAC and the derived per-purpose MAC, rejects others", () => {
    const payload = "user:1";
    const legacy = hmacHex(AUTH_A, payload);
    expect(verifyMac("greader-token", legacy, (key) => hmacHex(key, payload))).toBe(true);
    const ring = getKeyring();
    const derived = hmacHex(deriveMacKey(ring.current.master, "greader-token"), payload);
    expect(derived).not.toBe(legacy);
    expect(verifyMac("greader-token", derived, (key) => hmacHex(key, payload))).toBe(true);
    // a MAC derived for another purpose does not verify here
    const wrongPurpose = hmacHex(deriveMacKey(ring.current.master, "telegram-callback"), payload);
    expect(verifyMac("greader-token", wrongPurpose, (key) => hmacHex(key, payload))).toBe(false);
    expect(verifyMac("greader-token", "00".repeat(32), (key) => hmacHex(key, payload))).toBe(false);
  });
});

describe("FEEDFERRET_ENCRYPTION_KEY validation", () => {
  it("requires base64 of ≥32 bytes in production only", () => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    expect(() => validateEncryptionKey(undefined, true)).not.toThrow();
    expect(() => validateEncryptionKey(ENC_KEY, true)).not.toThrow();
    expect(() => validateEncryptionKey(Buffer.alloc(32, 1).toString("base64url"), true)).not.toThrow();
    expect(() => validateEncryptionKey("short", true)).toThrow(/FEEDFERRET_ENCRYPTION_KEY/);
    expect(() => validateEncryptionKey("not base64 !!! but long enough to pass a length check", true)).toThrow();
    expect(() => validateEncryptionKey("short", false)).not.toThrow();
  });
});
