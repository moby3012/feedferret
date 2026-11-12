import { db } from "@/lib/db";

/**
 * Per-ACCOUNT sign-in throttle, persisted in the database (User.failedLoginCount /
 * failedLoginWindowEnd), complementing the per-IP in-memory limiter (lib/rate-limit.ts): it survives
 * restarts, is shared by all replicas and holds against password guessing spread over many IPs.
 *
 * Model: a FIXED window of ACCOUNT_LOCKOUT.windowMs that starts with the first reserved attempt.
 * Every credential check reserves one attempt BEFORE the password is verified (so parallel guesses
 * cannot overshoot the limit: the increment is a single conditional UPDATE); a fully successful
 * sign-in gives its attempt back. Once `limit` attempts are outstanding the account refuses further
 * checks until the window ends. Refused attempts do not extend the window, so a lockout lasts at most
 * `windowMs`.
 *
 * DoS trade-off (documented in docs/security.md): anyone who knows an address can burn its 10
 * attempts and keep the password sign-in refused for up to 15 minutes at a time. That is deliberately
 * bounded and limited to password sign-in: existing sessions, magic-link/OAuth sign-in, API tokens and
 * Fever/GReader are unaffected, and a correct password + TOTP still unlocks nothing before the window
 * ends (exempting "correct credentials" would let the attacker keep guessing).
 */
export const ACCOUNT_LOCKOUT = { limit: 10, windowMs: 15 * 60 * 1000 } as const;

/**
 * Reserves one sign-in attempt for the account. Returns false when the account is locked (nothing is
 * reserved, the caller must not verify the password).
 */
export async function reserveLoginAttempt(userId: string, now: Date = new Date()): Promise<boolean> {
  // 1. A finished window starts over.
  await db.user.updateMany({
    where: { id: userId, failedLoginWindowEnd: { lt: now } },
    data: { failedLoginCount: 0, failedLoginWindowEnd: null },
  });
  // 2. Start a window if none is running (idempotent under concurrency: the first writer wins).
  await db.user.updateMany({
    where: { id: userId, failedLoginWindowEnd: null },
    data: { failedLoginWindowEnd: new Date(now.getTime() + ACCOUNT_LOCKOUT.windowMs) },
  });
  // 3. Atomic reserve: only succeeds while below the limit.
  const reserved = await db.user.updateMany({
    where: { id: userId, failedLoginCount: { lt: ACCOUNT_LOCKOUT.limit } },
    data: { failedLoginCount: { increment: 1 } },
  });
  return reserved.count === 1;
}

/** Gives back the attempt of a fully successful sign-in. */
export async function releaseLoginAttempt(userId: string): Promise<void> {
  await db.user.updateMany({
    where: { id: userId, failedLoginCount: { gt: 0 } },
    data: { failedLoginCount: { decrement: 1 } },
  });
}

/** Data fragment that clears the lockout (password change, admin reset). */
export const CLEAR_LOGIN_LOCKOUT = { failedLoginCount: 0, failedLoginWindowEnd: null } as const;
