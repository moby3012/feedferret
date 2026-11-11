// v1 secret format (sha256(AUTH_SECRET), `iv:tag:ct`). Writers still use it in
// this release; reads go through lib/secret-box.ts, which also understands
// the v2 `ff2.` format (security audit #2, M8 PR 4: read new, write old).
import { createCipheriv, createHash, randomBytes } from "crypto";
import { openSecret, warnSecretOnce } from "@/lib/secret-box";

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

export function encrypt(plaintext: string): string {
  const key = getKey();
  const iv = randomBytes(16);
  const cipher = createCipheriv(ALGORITHM, key, iv);
  const encrypted = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const authTag = cipher.getAuthTag();
  return [iv.toString("base64"), authTag.toString("base64"), encrypted.toString("base64")].join(":");
}

export function encryptIfValue(value: string | null | undefined): string | null {
  if (!value) return null;
  return encrypt(value);
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
