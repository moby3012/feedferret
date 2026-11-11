// Typed app-side wrapper around lib/secret-box-core.mjs (security audit #2, M8).
//
// M8 rollout: this release READS the v2 `ff2.` format everywhere but every
// writer still stores v1/plaintext, so rolling back one image is safe. The
// next release (M8 PR 5) switches writers to `sealSecret` and re-seals lazily.
import { createHmac, timingSafeEqual } from "crypto";
import {
  SECRET_COLUMNS,
  SecretKeyError,
  WEBHOOK_HEADER_PURPOSE,
  WEBHOOK_SECRET_PURPOSE,
  deriveMacKey,
  isV2,
  loadKeyring,
  openSecret as openSecretCore,
  sealV2,
} from "./secret-box-core.mjs";

export { SECRET_COLUMNS, SecretKeyError, WEBHOOK_HEADER_PURPOSE, WEBHOOK_SECRET_PURPOSE, isV2 };

export type Keyring = ReturnType<typeof loadKeyring>;
export type LegacyFormat = "plaintext" | "v1";
export type OpenedSecret = { value: string; stale: boolean; format: "v2" | "v1" | "plaintext"; kid: string | null };

let cached: { signature: string; keyring: Keyring } | null = null;

/** Keyring from the environment, cached until the relevant env vars change (tests swap them). */
export function getKeyring(): Keyring {
  const signature = [
    process.env.FEEDFERRET_ENCRYPTION_KEY ?? "",
    process.env.AUTH_SECRET ?? "",
    process.env.FEEDFERRET_ENCRYPTION_KEYS_OLD ?? "",
    process.env.NEXT_PHASE ?? "",
  ].join("\u0000");
  if (cached?.signature !== signature) cached = { signature, keyring: loadKeyring(process.env) };
  return cached.keyring;
}

/** Decrypt any supported format. Throws `SecretKeyError` when the value exists but the keys do not fit. */
export function openSecret(purpose: string, stored: string, legacy: LegacyFormat): OpenedSecret {
  return openSecretCore(purpose, stored, { legacy, keyring: getKeyring }) as OpenedSecret;
}

/** Seal with the current key (v2). Not used by writers in this release — see header. */
export function sealSecret(purpose: string, plaintext: string): string {
  return sealV2(purpose, plaintext, getKeyring());
}

const warned = new Set<string>();

/** Log an undecryptable column once per process — purpose and reason only, never the value. */
export function warnSecretOnce(error: unknown, purpose: string) {
  const key = `${purpose}:${error instanceof SecretKeyError ? error.reason : "error"}`;
  if (warned.has(key)) return;
  warned.add(key);
  const reason = error instanceof SecretKeyError ? error.message : `Secret for ${purpose} could not be read.`;
  console.warn(`[secrets] ${reason}`);
}

/**
 * Read a column that used to be plaintext. Returns null for empty values;
 * throws `SecretKeyError` (fail closed) when a v2 value cannot be opened.
 */
export function readPlainColumn(purpose: string, stored: string | null | undefined): string | null {
  if (stored == null || stored === "") return null;
  return openSecret(purpose, stored, "plaintext").value;
}

/** Like `readPlainColumn`, but logs once and returns null instead of throwing (optional secrets). */
export function readPlainColumnOrNull(purpose: string, stored: string | null | undefined): string | null {
  try {
    return readPlainColumn(purpose, stored);
  } catch (error) {
    warnSecretOnce(error, purpose);
    return null;
  }
}

/**
 * HMAC with domain separation: the current signature uses the raw AUTH_SECRET
 * (legacy, still issued in this release so an older image keeps verifying),
 * and `verifyMac` additionally accepts HKDF-derived per-purpose keys
 * (current + old masters), which the next release starts to issue.
 */
export function legacyMacSecret(): string {
  const value = process.env.AUTH_SECRET;
  if (value) return value;
  if (process.env.NEXT_PHASE === "phase-production-build") return "build-time-secret-only";
  throw new Error("AUTH_SECRET must be set.");
}

export function macCandidates(purpose: string): Array<string | Buffer> {
  const keyring = getKeyring();
  return [legacyMacSecret(), ...[keyring.current, ...keyring.old].map((k) => deriveMacKey(k.master, purpose))];
}

/** Constant-time compare of `actual` against `sign(key)` for every candidate key. */
export function verifyMac(purpose: string, actual: string, sign: (key: string | Buffer) => string): boolean {
  const actualBuf = Buffer.from(actual);
  let ok = false;
  for (const key of macCandidates(purpose)) {
    const expected = Buffer.from(sign(key));
    if (expected.length === actualBuf.length && timingSafeEqual(expected, actualBuf)) ok = true;
  }
  return ok;
}

export function hmacHex(key: string | Buffer, payload: string): string {
  return createHmac("sha256", key).update(payload).digest("hex");
}
