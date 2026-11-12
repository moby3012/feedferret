import { db } from "@/lib/db";
import { openSecret, readPlainColumn, sealSecret, warnSecretOnce } from "@/lib/secret-box";
import { matchingTotpStep } from "@/lib/totp";

export const TOTP_SECRET_PURPOSE = "user.twoFactorSecret";

/**
 * Decrypt a stored `twoFactorSecret` (plaintext or v2). Fails closed: a value
 * that cannot be opened with the configured keys yields null (logged once).
 */
export function readTotpSecret(stored: string | null | undefined): string | null {
  try {
    return readPlainColumn(TOTP_SECRET_PURPOSE, stored);
  } catch (error) {
    warnSecretOnce(error, TOTP_SECRET_PURPOSE);
    return null;
  }
}

/**
 * Atomic monotonic claim prevents concurrent requests reusing the same code.
 *
 * `storedSecret` is the column value exactly as stored (plaintext or v2
 * `ff2.` ciphertext). It is decrypted here for the TOTP check, while the CAS
 * `where` compares the *stored* string, so the claim works for either format
 * and fails if the secret was changed concurrently. A stale stored value
 * (legacy plaintext or an old key) is re-sealed in the same CAS update.
 */
export async function consumeTotpToken(userId: string, storedSecret: string, token: string) {
  let opened: { value: string; stale: boolean };
  try {
    opened = openSecret(TOTP_SECRET_PURPOSE, storedSecret, "plaintext");
  } catch (error) {
    warnSecretOnce(error, TOTP_SECRET_PURPOSE);
    return false;
  }
  if (!opened.value) return false;
  const step = matchingTotpStep(opened.value, token);
  if (step === null) return false;
  let resealed: string | null = null;
  if (opened.stale) {
    try {
      resealed = sealSecret(TOTP_SECRET_PURPOSE, opened.value);
    } catch {
      resealed = null; // never block a valid login on the lazy re-seal
    }
  }
  const result = await db.user.updateMany({
    where: { id: userId, twoFactorEnabled: true, twoFactorSecret: storedSecret,
      OR: [{ twoFactorLastAcceptedStep: null }, { twoFactorLastAcceptedStep: { lt: step } }] },
    data: { twoFactorLastAcceptedStep: step, ...(resealed ? { twoFactorSecret: resealed } : {}) },
  });
  return result.count === 1;
}
