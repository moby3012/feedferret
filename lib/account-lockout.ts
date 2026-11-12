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
 * Two independent counters ("scopes"): "web" (browser sign-in, Auth.js Credentials) and "api" (Google
 * Reader / Fever Basic auth when it accepts the main password). Separate so a sync client with a stale
 * password cannot lock the owner out of the web sign-in; the cost is that a guesser gets at most
 * 2 × limit tries per window.
 *
 * DoS trade-off (documented in docs/security.md): anyone who knows an address can burn its 10
 * attempts and keep the password sign-in refused for up to 15 minutes at a time. That is deliberately
 * bounded and limited to password sign-in: existing sessions, magic-link/OAuth sign-in and API
 * tokens are unaffected, and a correct password + TOTP does not bypass an active lockout (exempting
 * "correct credentials" would let the attacker keep guessing). An operator can clear a lockout with
 * `node scripts/auth-cli.mjs unlock-user <email>` (also done by `create-user`).
 *
 * Clock: windows are compared against the application server's clock (`new Date()`), not the
 * database's. With several replicas keep them NTP-synchronised; skew of a few seconds only shifts the
 * window end by that much. Writes touch `User.updatedAt` (Prisma `@updatedAt`); nothing reads it for
 * users.
 */
export const ACCOUNT_LOCKOUT = { limit: 10, windowMs: 15 * 60 * 1000 } as const;

export type LockoutScope = "web" | "api";

const FIELDS = {
  web: { count: "failedLoginCount", end: "failedLoginWindowEnd" },
  api: { count: "failedApiLoginCount", end: "failedApiLoginWindowEnd" },
} as const;

/**
 * Reserves one sign-in attempt for the account and returns the END OF THE WINDOW it was charged to
 * (the reservation token), or null when the account is locked (nothing is reserved, the caller must
 * not verify the password). Pass the token to `releaseLoginAttempt`: a refund is only applied while
 * that very window is still running, so a success reserved before a rollover cannot decrement the
 * budget of the next window (which would hand an attacker an extra guess per slow success).
 */
export async function reserveLoginAttempt(userId: string, scope: LockoutScope = "web", now: Date = new Date()): Promise<Date | null> {
  const f = FIELDS[scope];
  const endOf = async () => ((await db.user.findUnique({ where: { id: userId }, select: { [f.end]: true } })) as Record<string, Date | null> | null)?.[f.end] ?? null;
  for (let attempt = 0; attempt < 3; attempt++) {
    // 1. A finished window starts over.
    await db.user.updateMany({
      where: { id: userId, [f.end]: { lt: now } },
      data: { [f.count]: 0, [f.end]: null },
    });
    // 2. Start a window if none is running (idempotent under concurrency: the first writer wins).
    await db.user.updateMany({
      where: { id: userId, [f.end]: null },
      data: { [f.end]: new Date(now.getTime() + ACCOUNT_LOCKOUT.windowMs) },
    });
    // 3. Atomic reserve bound to the window just read: only succeeds while below the limit AND while
    //    the window is still that one. A concurrent rollover makes the conditional update match
    //    nothing; then we start over against the new window instead of charging the wrong one.
    const windowEnd = await endOf();
    if (!windowEnd) continue; // unknown user or a rollover raced step 2
    const reserved = await db.user.updateMany({
      where: { id: userId, [f.end]: windowEnd, [f.count]: { lt: ACCOUNT_LOCKOUT.limit } },
      data: { [f.count]: { increment: 1 } },
    });
    if (reserved.count === 1) return windowEnd;
    const after = await endOf();
    if (after?.getTime() === windowEnd.getTime()) return null; // same window, at its limit: locked
  }
  return null;
}

/** Gives back the attempt of a fully successful sign-in, but only inside the window it was reserved in. */
export async function releaseLoginAttempt(userId: string, scope: LockoutScope = "web", windowEnd?: Date | null): Promise<void> {
  if (!windowEnd) return;
  const f = FIELDS[scope];
  await db.user.updateMany({
    where: { id: userId, [f.end]: windowEnd, [f.count]: { gt: 0 } },
    data: { [f.count]: { decrement: 1 } },
  });
}

/**
 * `User` update fragment that clears BOTH lockouts. Used when the credential itself changes (password
 * change), by `create-user` (re-provisioning an account) and by `unlock-user`
 * (scripts/auth-cli.mjs duplicates these four fields; keep them in sync).
 */
export const CLEAR_LOGIN_LOCKOUT = {
  failedLoginCount: 0, failedLoginWindowEnd: null, failedApiLoginCount: 0, failedApiLoginWindowEnd: null,
} as const;
