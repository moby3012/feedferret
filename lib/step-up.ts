import bcrypt from "bcryptjs";
import { db } from "@/lib/db";
import { consumeTotpToken } from "@/lib/totp-consume";

/** A passwordless account (SSO / magic link, no TOTP) may act within this window after signing in. */
export const STEP_UP_FRESH_SESSION_SECS = 600;

export type StepUpInput = { currentPassword?: unknown; totp?: unknown };
export type StepUpResult = { ok: true } | { ok: false; code: "stepUpRequired" | "reloginRequired" };

/**
 * Re-authentication for sensitive account changes (API password, email
 * change). Accepts, in order: the current login password, a fresh TOTP code
 * (consumed atomically, so it cannot be replayed), or — only for accounts that
 * have neither — a session signed in at most 10 minutes ago.
 *
 * `authenticatedAt` is the session's sign-in time in epoch seconds
 * (`session.authenticatedAt`). Callers apply their own rate limit first.
 */
export async function verifyStepUp(
  user: { id: string; authenticatedAt?: number | null },
  input: StepUpInput,
): Promise<StepUpResult> {
  const account = await db.user.findUniqueOrThrow({
    where: { id: user.id },
    select: { password: true, twoFactorEnabled: true, twoFactorSecret: true },
  });
  const password = input?.currentPassword;
  const passwordMatches =
    typeof password === "string" &&
    password.length > 0 &&
    Buffer.byteLength(password) <= 72 &&
    !!account.password &&
    (await bcrypt.compare(password, account.password));
  if (passwordMatches) return { ok: true };

  const totp = input?.totp;
  const totpMatches =
    typeof totp === "string" &&
    /^\d{6}$/.test(totp.trim()) &&
    account.twoFactorEnabled &&
    !!account.twoFactorSecret &&
    (await consumeTotpToken(user.id, account.twoFactorSecret, totp.trim()));
  if (totpMatches) return { ok: true };

  const passwordless = !account.password && !account.twoFactorEnabled;
  if (passwordless) {
    const age = typeof user.authenticatedAt === "number" ? Date.now() / 1000 - user.authenticatedAt : Infinity;
    if (age >= 0 && age <= STEP_UP_FRESH_SESSION_SECS) return { ok: true };
    return { ok: false, code: "reloginRequired" };
  }
  return { ok: false, code: "stepUpRequired" };
}
