import { db } from "@/lib/db";
import { matchingTotpStep } from "@/lib/totp";

/** Atomic monotonic claim prevents concurrent requests reusing the same code. */
export async function consumeTotpToken(userId: string, secret: string, token: string) {
  const step = matchingTotpStep(secret, token);
  if (step === null) return false;
  const result = await db.user.updateMany({
    where: { id: userId, twoFactorEnabled: true, twoFactorSecret: secret,
      OR: [{ twoFactorLastAcceptedStep: null }, { twoFactorLastAcceptedStep: { lt: step } }] },
    data: { twoFactorLastAcceptedStep: step },
  });
  return result.count === 1;
}
