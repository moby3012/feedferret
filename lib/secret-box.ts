// Typed app-side wrapper around lib/secret-box-core.mjs (security audit #2, M8).
//
// M8 rollout: PR 4 taught every reader the v2 `ff2.` format; PR 5 (this
// release) seals every write with the current key (`sealSecret`, plus the
// db write extension in lib/secret-sealing.ts) and re-seals stored legacy /
// old-key values in the background (lib/secret-migration.ts).
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
  prepareForWrite,
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

/**
 * Prepare user input for a secret column: plaintext is sealed; an
 * envelope-shaped value (`ff2.` / v1 in a v1 column) is kept only if it
 * decrypts for this purpose, otherwise SecretKeyError (fail closed).
 */
export function sealInputForColumn(purpose: string, value: string): string {
  const legacy = (SECRET_COLUMNS.find((c) => c.purpose === purpose)?.legacy ?? "plaintext") as LegacyFormat;
  return prepareForWrite(purpose, value, legacy, getKeyring());
}

/** Seal with the current key (v2). `purpose` = registry purpose, e.g. "feed.authPassword" (AAD). */
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

/**
 * Like `readPlainColumn`, but never throws: `unreadable` is true when a value
 * is stored but the configured keys cannot open it (logged once, no value).
 * Callers must not treat an unreadable secret like an absent one.
 */
export function readPlainColumnState(purpose: string, stored: string | null | undefined): { value: string | null; unreadable: boolean } {
  try {
    return { value: readPlainColumn(purpose, stored), unreadable: false };
  } catch (error) {
    warnSecretOnce(error, purpose);
    return { value: null, unreadable: true };
  }
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
 * HMAC with domain separation: signatures are issued with an HKDF-derived
 * per-purpose key of the current master key (`currentMacKey`). `verifyMac`
 * accepts that key, the derived keys of every old master key and, until
 * FEEDFERRET_LEGACY_MAC_UNTIL (ISO date, optional) has passed, the legacy raw
 * AUTH_SECRET signature that releases before M8 PR 5 issued.
 */
export function legacyMacSecret(): string {
  const value = process.env.AUTH_SECRET;
  if (value) return value;
  if (process.env.NEXT_PHASE === "phase-production-build") return "build-time-secret-only";
  throw new Error("AUTH_SECRET must be set.");
}

let warnedLegacyMacUntil = false;

/**
 * Parsed FEEDFERRET_LEGACY_MAC_UNTIL (ms), or null when unset. An unparsable
 * value is treated as NOT SET (legacy MACs keep verifying) and warned once.
 */
export function legacyMacCutoff(): number | null {
  const until = process.env.FEEDFERRET_LEGACY_MAC_UNTIL?.trim();
  if (!until) return null;
  const cutoff = Date.parse(until);
  if (Number.isNaN(cutoff)) {
    if (!warnedLegacyMacUntil) {
      warnedLegacyMacUntil = true;
      console.warn("[secrets] FEEDFERRET_LEGACY_MAC_UNTIL is not a valid ISO date; ignoring it (legacy GReader/Telegram signatures stay accepted).");
    }
    return null;
  }
  return cutoff;
}

export function legacyMacAccepted(now = Date.now()): boolean {
  const cutoff = legacyMacCutoff();
  return cutoff === null || now < cutoff;
}

export function currentMacKey(purpose: string): Buffer {
  return deriveMacKey(getKeyring().current.master, purpose);
}

export function macCandidates(purpose: string): Array<string | Buffer> {
  const keyring = getKeyring();
  const derived = [keyring.current, ...keyring.old].map((k) => deriveMacKey(k.master, purpose));
  if (!legacyMacAccepted()) return derived;
  let legacy: string | null = null;
  try {
    legacy = legacyMacSecret();
  } catch {
    legacy = null; // FEEDFERRET_ENCRYPTION_KEY without AUTH_SECRET: no legacy signatures to accept
  }
  return legacy ? [...derived, legacy] : derived;
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
