// Compat shim for the secret helpers (security audit #2, M8). Writers seal the
// v2 `ff2.` format (lib/secret-box.ts); reads accept v2, legacy v1
// (sha256(AUTH_SECRET), `iv:tag:ct`) and, per column, legacy plaintext.
import { createCipheriv, createHash, randomBytes } from "crypto";
import { openSecret, sealInputForColumn, warnSecretOnce } from "@/lib/secret-box";

const ALGORITHM = "aes-256-gcm";

function getKey(): Buffer {
  let secret = process.env.AUTH_SECRET;
  if (!secret) {
    if (process.env.NEXT_PHASE === "phase-production-build") {
      secret = "build-time-secret-only";
    } else {
      throw new Error("AUTH_SECRET must be set to encrypt/decrypt secrets.");
    }
  }
  return createHash("sha256").update(secret).digest();
}

/** Legacy v1 encryption. No writer uses it any more; kept for tests and v1 fixtures. */
export function encrypt(plaintext: string): string {
  const key = getKey();
  const iv = randomBytes(16);
  const cipher = createCipheriv(ALGORITHM, key, iv);
  const encrypted = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const authTag = cipher.getAuthTag();
  return [iv.toString("base64"), authTag.toString("base64"), encrypted.toString("base64")].join(":");
}

/**
 * Seal a secret for storage (v2, current key). `purpose` is the column's
 * registry purpose (`lib/secret-box-core.mjs` SECRET_COLUMNS), e.g.
 * "user.aiApiKey": it binds the ciphertext to that column (AAD). Envelope-shaped
 * input that does not decrypt for this column throws SecretKeyError.
 */
export function encryptIfValue(value: string | null | undefined, purpose: string): string | null {
  if (!value) return null;
  return sealInputForColumn(purpose, value);
}

/**
 * Decrypt a column that is stored v1 (or v2). `purpose` is the column's
 * registry purpose (`lib/secret-box-core.mjs` SECRET_COLUMNS), e.g. "user.aiApiKey".
 * Returns null when empty or undecryptable; the latter is logged once per column.
 */
export function decryptIfValue(value: string | null | undefined, purpose: string): string | null {
  if (!value) return null;
  try {
    return openSecret(purpose, value, "v1").value;
  } catch (error) {
    warnSecretOnce(error, purpose);
    return null;
  }
}
