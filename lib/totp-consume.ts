import { db } from "@/lib/db";
import { readPlainColumn, warnSecretOnce } from "@/lib/secret-box";
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
 * and fails if the secret was changed concurrently.
 */
export async function consumeTotpToken(userId: string, storedSecret: string, token: string) {
  const secret = readTotpSecret(storedSecret);
  if (!secret) return false;
  const step = matchingTotpStep(secret, token);
  if (step === null) return false;
  const result = await db.user.updateMany({
    where: { id: userId, twoFactorEnabled: true, twoFactorSecret: storedSecret,
      OR: [{ twoFactorLastAcceptedStep: null }, { twoFactorLastAcceptedStep: { lt: step } }] },
    data: { twoFactorLastAcceptedStep: step },
  });
  return result.count === 1;
}
