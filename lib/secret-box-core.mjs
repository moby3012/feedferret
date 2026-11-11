// Secret box core (security audit #2, M8): plain ESM so both the Next.js app
// (via lib/secret-box.ts) and the standalone CLI (scripts/secrets-cli.mjs)
// share one implementation of key derivation, the stored formats and the
// registry of secret columns. Never log or return plaintext from here.
//
// Stored formats:
//   v2 (ff2):  ff2.<kid>.<b64url iv(12)>.<b64url ciphertext||tag(16)>
//              AES-256-GCM, key = HKDF-SHA256(master, salt "feedferret/v2", info purpose),
//              AAD = purpose, so a value cannot be moved to another column.
//   v1:        <b64 iv(16)>:<b64 tag>:<b64 ct>, key = sha256(AUTH_SECRET), no AAD (lib/crypto.ts).
//   plaintext: anything else, only for columns that were never encrypted.
//
// PR 4 of the M8 rollout only READS v2. Writers keep producing v1/plaintext so
// that rolling back one image never makes stored secrets unreadable.
import { createCipheriv, createDecipheriv, createHash, hkdfSync, randomBytes } from "node:crypto";

export const V2_PREFIX = "ff2.";
const V2_SALT = "feedferret/v2";
const V2_RE = /^ff2\.([0-9a-f]{8})\.([A-Za-z0-9_-]{16})\.([A-Za-z0-9_-]{22,})$/;
const V1_RE = /^[A-Za-z0-9+/]+={0,2}:[A-Za-z0-9+/]+={0,2}:[A-Za-z0-9+/]*={0,2}$/;
const BUILD_SECRET = "build-time-secret-only";

/** Thrown when a stored secret exists but cannot be decrypted with the configured keys. */
export class SecretKeyError extends Error {
  /**
   * @param {string} purpose
   * @param {"unknown-kid" | "wrong-key" | "malformed"} reason
   * @param {string | null} [kid]
   */
  constructor(purpose, reason, kid = null) {
    super(
      reason === "unknown-kid"
        ? `Secret for ${purpose} was sealed with unknown key id ${kid}; set FEEDFERRET_ENCRYPTION_KEY or add the old key to FEEDFERRET_ENCRYPTION_KEYS_OLD.`
        : reason === "wrong-key"
          ? `Secret for ${purpose} cannot be decrypted with the configured key (wrong key or corrupted value).`
          : `Secret for ${purpose} has an invalid encrypted format.`,
    );
    this.name = "SecretKeyError";
    this.purpose = purpose;
    this.reason = reason;
    this.kid = kid;
  }
}

/**
 * Master key material. A value is used verbatim (its UTF-8 bytes) as HKDF
 * input, so moving a value from FEEDFERRET_ENCRYPTION_KEY or AUTH_SECRET to
 * FEEDFERRET_ENCRYPTION_KEYS_OLD keeps its key id.
 *
 * @param {Record<string, string | undefined>} [env]
 * @returns {{ current: { kid: string, master: Buffer, source: string }, old: Array<{ kid: string, master: Buffer, source: string }>, v1Secrets: string[] }}
 */
export function loadKeyring(env = process.env) {
  let currentRaw = env.FEEDFERRET_ENCRYPTION_KEY?.trim() || "";
  let source = "FEEDFERRET_ENCRYPTION_KEY";
  if (!currentRaw) {
    currentRaw = env.AUTH_SECRET || "";
    source = "AUTH_SECRET";
  }
  if (!currentRaw) {
    if (env.NEXT_PHASE === "phase-production-build") {
      currentRaw = BUILD_SECRET;
      source = "build";
    } else {
      throw new Error("FEEDFERRET_ENCRYPTION_KEY or AUTH_SECRET must be set to read stored secrets.");
    }
  }
  const current = keyEntry(currentRaw, source);
  const seen = new Set([current.kid]);
  const old = [];
  for (const raw of (env.FEEDFERRET_ENCRYPTION_KEYS_OLD || "").split(",")) {
    const value = raw.trim();
    if (!value) continue;
    const entry = keyEntry(value, "FEEDFERRET_ENCRYPTION_KEYS_OLD");
    if (seen.has(entry.kid)) continue;
    seen.add(entry.kid);
    old.push(entry);
  }
  // v1 values were always keyed by sha256(AUTH_SECRET); old keys are tried too
  // so an AUTH_SECRET rotation done "the documented way" keeps v1 readable.
  const v1Secrets = [...new Set([env.AUTH_SECRET || (source === "build" ? BUILD_SECRET : ""), currentRaw,
    ...(env.FEEDFERRET_ENCRYPTION_KEYS_OLD || "").split(",").map((v) => v.trim())].filter(Boolean))];
  return { current, old, v1Secrets };
}

/** @param {string} raw @param {string} source */
function keyEntry(raw, source) {
  const master = Buffer.from(raw, "utf8");
  return { kid: keyId(master), master, source };
}

/** @param {Buffer} master */
export function keyId(master) {
  return Buffer.from(hkdfSync("sha256", master, V2_SALT, "kid", 4)).toString("hex");
}

/** @param {Buffer} master @param {string} purpose */
export function deriveKey(master, purpose) {
  return Buffer.from(hkdfSync("sha256", master, V2_SALT, purpose, 32));
}

/**
 * Domain-separated HMAC key (GReader tokens, Telegram callbacks, …).
 * @param {Buffer} master @param {string} purpose
 */
export function deriveMacKey(master, purpose) {
  return Buffer.from(hkdfSync("sha256", master, "feedferret/mac", purpose, 32));
}

/**
 * Seal with the current key. Not used by any writer yet (M8 PR 5 switches the
 * writers); exported for tests and for the next release.
 * @param {string} purpose @param {string} plaintext @param {ReturnType<typeof loadKeyring>} [keyring]
 */
export function sealV2(purpose, plaintext, keyring = loadKeyring()) {
  if (keyring.current.source === "build") throw new Error("Refusing to seal secrets during the production build.");
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", deriveKey(keyring.current.master, purpose), iv);
  cipher.setAAD(Buffer.from(purpose, "utf8"));
  const ct = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final(), cipher.getAuthTag()]);
  return `${V2_PREFIX}${keyring.current.kid}.${iv.toString("base64url")}.${ct.toString("base64url")}`;
}

/** @param {string} value */
export function isV2(value) {
  return typeof value === "string" && V2_RE.test(value);
}

/** @param {string} value */
export function looksLikeV1(value) {
  return typeof value === "string" && V1_RE.test(value);
}

/** @param {string} value @returns {string | null} */
export function v2KeyId(value) {
  const m = typeof value === "string" ? V2_RE.exec(value) : null;
  return m ? m[1] : null;
}

/**
 * @param {string} purpose @param {string} stored @param {ReturnType<typeof loadKeyring>} keyring
 * @returns {{ value: string, kid: string }}
 */
function openV2(purpose, stored, keyring) {
  const m = V2_RE.exec(stored);
  if (!m) throw new SecretKeyError(purpose, "malformed");
  const [, kid, ivB64, ctB64] = m;
  const key = [keyring.current, ...keyring.old].find((k) => k.kid === kid);
  if (!key) throw new SecretKeyError(purpose, "unknown-kid", kid);
  const iv = Buffer.from(ivB64, "base64url");
  const data = Buffer.from(ctB64, "base64url");
  if (iv.length !== 12 || data.length < 16) throw new SecretKeyError(purpose, "malformed", kid);
  try {
    const decipher = createDecipheriv("aes-256-gcm", deriveKey(key.master, purpose), iv);
    decipher.setAAD(Buffer.from(purpose, "utf8"));
    decipher.setAuthTag(data.subarray(data.length - 16));
    const value = Buffer.concat([decipher.update(data.subarray(0, data.length - 16)), decipher.final()]).toString("utf8");
    return { value, kid };
  } catch {
    throw new SecretKeyError(purpose, "wrong-key", kid);
  }
}

/** @param {string} stored @param {string} secret */
function tryOpenV1(stored, secret) {
  const [ivB64, tagB64, ctB64] = stored.split(":");
  const decipher = createDecipheriv("aes-256-gcm", createHash("sha256").update(secret).digest(), Buffer.from(ivB64, "base64"));
  decipher.setAuthTag(Buffer.from(tagB64, "base64"));
  return Buffer.concat([decipher.update(Buffer.from(ctB64, "base64")), decipher.final()]).toString("utf8");
}

/**
 * Decrypt a stored secret in any supported format.
 *
 * `legacy` is per column: "plaintext" columns never try the v1 parse
 * (passwords and JSON contain colons), "v1" columns must be v1 or v2.
 * `stale` is true when the value is not v2 under the current key (PR 5 re-seals those).
 *
 * @param {string} purpose
 * @param {string} stored
 * The keyring is only resolved when a value is actually encrypted, so legacy
 * plaintext reads never need a key.
 *
 * @param {{ legacy: "plaintext" | "v1", keyring?: ReturnType<typeof loadKeyring> | (() => ReturnType<typeof loadKeyring>) }} options
 * @returns {{ value: string, stale: boolean, format: "v2" | "v1" | "plaintext", kid: string | null }}
 */
export function openSecret(purpose, stored, { legacy, keyring: keyringOption }) {
  const resolveKeyring = () =>
    typeof keyringOption === "function" ? keyringOption() : keyringOption ?? loadKeyring();
  if (isV2(stored)) {
    const keyring = resolveKeyring();
    const { value, kid } = openV2(purpose, stored, keyring);
    return { value, stale: kid !== keyring.current.kid, format: "v2", kid };
  }
  if (legacy === "plaintext") return { value: stored, stale: true, format: "plaintext", kid: null };
  if (!looksLikeV1(stored)) throw new SecretKeyError(purpose, "malformed");
  const keyring = resolveKeyring();
  for (const secret of keyring.v1Secrets) {
    try {
      return { value: tryOpenV1(stored, secret), stale: true, format: "v1", kid: null };
    } catch {
      // try the next candidate key
    }
  }
  throw new SecretKeyError(purpose, "wrong-key");
}

/**
 * Every column holding a secret. `legacy` = what pre-v2 rows contain.
 * `json` columns hold JSON whose listed string fields are secrets.
 * Shared with the CLI (`secrets:status`) and the PR 5 migration job.
 *
 * @type {ReadonlyArray<{ model: string, column: string, purpose: string, legacy: "plaintext" | "v1", json?: "webhooks" }>}
 */
export const SECRET_COLUMNS = [
  // previously plaintext
  { model: "user", column: "twoFactorSecret", purpose: "user.twoFactorSecret", legacy: "plaintext" },
  { model: "user", column: "telegramBotToken", purpose: "user.telegramBotToken", legacy: "plaintext" },
  { model: "user", column: "gotifyToken", purpose: "user.gotifyToken", legacy: "plaintext" },
  { model: "user", column: "ntfyToken", purpose: "user.ntfyToken", legacy: "plaintext" },
  { model: "feed", column: "authUsername", purpose: "feed.authUsername", legacy: "plaintext" },
  { model: "feed", column: "authPassword", purpose: "feed.authPassword", legacy: "plaintext" },
  { model: "feed", column: "httpOptions", purpose: "feed.httpOptions", legacy: "plaintext" },
  { model: "autoReadRule", column: "webhookConfigs", purpose: "autoReadRule.webhookConfigs", legacy: "plaintext", json: "webhooks" },
  // already v1-encrypted
  { model: "user", column: "aiApiKey", purpose: "user.aiApiKey", legacy: "v1" },
  { model: "user", column: "contentFetchApiKey", purpose: "user.contentFetchApiKey", legacy: "v1" },
  { model: "user", column: "exportWallabagClientSecret", purpose: "user.exportWallabagClientSecret", legacy: "v1" },
  { model: "user", column: "exportWallabagPassword", purpose: "user.exportWallabagPassword", legacy: "v1" },
  { model: "globalSettings", column: "smtpPassword", purpose: "globalSettings.smtpPassword", legacy: "v1" },
  { model: "globalSettings", column: "resendApiKey", purpose: "globalSettings.resendApiKey", legacy: "v1" },
  { model: "globalSettings", column: "postmarkServerToken", purpose: "globalSettings.postmarkServerToken", legacy: "v1" },
  { model: "globalSettings", column: "mailgunApiKey", purpose: "globalSettings.mailgunApiKey", legacy: "v1" },
  { model: "globalSettings", column: "sendgridApiKey", purpose: "globalSettings.sendgridApiKey", legacy: "v1" },
  { model: "globalSettings", column: "renderSidecarToken", purpose: "globalSettings.renderSidecarToken", legacy: "v1" },
  { model: "globalSettings", column: "rsshubApiKey", purpose: "globalSettings.rsshubApiKey", legacy: "v1" },
  { model: "globalSettings", column: "changedetectionApiKey", purpose: "globalSettings.changedetectionApiKey", legacy: "v1" },
  { model: "globalSettings", column: "changedetectionRssToken", purpose: "globalSettings.changedetectionRssToken", legacy: "v1" },
];

/** Purposes for the secret string fields inside `AutoReadRule.webhookConfigs` JSON. */
export const WEBHOOK_SECRET_PURPOSE = "autoReadRule.webhookConfigs.secret";
export const WEBHOOK_HEADER_PURPOSE = "autoReadRule.webhookConfigs.header";

/**
 * Classify one stored value without returning its plaintext.
 * @param {string | null | undefined} stored
 * @param {{ purpose: string, legacy: "plaintext" | "v1" }} column
 * @param {ReturnType<typeof loadKeyring>} keyring
 * @returns {string} bucket: "empty" | "plaintext" | "v1" | "v2:<kid>" with ":current" / ":old" / ":unknown" | "undecryptable"
 */
export function classifySecret(stored, column, keyring) {
  if (stored == null || stored === "") return "empty";
  if (isV2(stored)) {
    const kid = v2KeyId(stored);
    const where = kid === keyring.current.kid ? "current" : keyring.old.some((k) => k.kid === kid) ? "old" : "unknown";
    if (where === "unknown") return `v2:${kid}:unknown`;
    try {
      openSecret(column.purpose, stored, { legacy: column.legacy, keyring });
      return `v2:${kid}:${where}`;
    } catch {
      return "undecryptable";
    }
  }
  if (column.legacy === "plaintext") return "plaintext";
  try {
    openSecret(column.purpose, stored, { legacy: "v1", keyring });
    return "v1";
  } catch {
    return "undecryptable";
  }
}

/**
 * Classify every secret inside a webhookConfigs JSON value.
 * @param {string | null | undefined} stored
 * @param {ReturnType<typeof loadKeyring>} keyring
 * @returns {string[]}
 */
export function classifyWebhookJson(stored, keyring) {
  if (!stored) return [];
  let parsed;
  try {
    parsed = JSON.parse(stored);
  } catch {
    return ["invalid-json"];
  }
  if (!Array.isArray(parsed)) return [];
  const out = [];
  for (const item of parsed) {
    if (!item || typeof item !== "object") continue;
    if (typeof item.secret === "string" && item.secret) {
      out.push(classifySecret(item.secret, { purpose: WEBHOOK_SECRET_PURPOSE, legacy: "plaintext" }, keyring));
    }
    if (item.headers && typeof item.headers === "object") {
      for (const value of Object.values(item.headers)) {
        if (typeof value === "string" && value) {
          out.push(classifySecret(value, { purpose: WEBHOOK_HEADER_PURPOSE, legacy: "plaintext" }, keyring));
        }
      }
    }
  }
  return out;
}
