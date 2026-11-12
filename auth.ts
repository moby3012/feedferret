import NextAuth, { CredentialsSignin } from "next-auth";
import { PrismaAdapter } from "@auth/prisma-adapter";
import { db } from "@/lib/db";
import authConfig from "./auth.config";
import Credentials from "next-auth/providers/credentials";
import Nodemailer from "next-auth/providers/nodemailer";
import bcrypt from "bcryptjs";
import { createHash } from "node:crypto";
import { consumeTotpToken } from "@/lib/totp-consume";
import { sendSignInEmail } from "@/lib/mail";

import { validateAuthSecret } from "@/lib/auth-secret";
import { checkRateLimit, getClientIp } from "@/lib/rate-limit";
import { ACCOUNT_LOCKOUT, reserveLoginAttempt, releaseLoginAttempt } from "@/lib/account-lockout";

/**
 * Thrown (and surfaced to the client as `code`) only AFTER the password has been verified for an account
 * with two-factor authentication when no code was sent, so the login form can ask for it. Everything
 * else stays an anonymous failure, so nothing is revealed to someone who does not know the password.
 */
class OtpRequiredError extends CredentialsSignin {
  code = "otp_required";
}

// bcrypt cost 10 (the cost passwords are stored with). Compared against when the address has no usable
// password so that unknown, passwordless and real accounts all pay for one bcrypt verification.
const DUMMY_PASSWORD_HASH = "$2b$10$Dmqlm9TPbrYCteuNDvDYPeeNEYbadATy4JMRE63VgxWS076h2o7Z.";

/**
 * Stand-in for the per-account database lockout for addresses that have none (unknown or passwordless):
 * same budget and window as `ACCOUNT_LOCKOUT`, kept in memory, keyed by the address. Without it an
 * attacker could tell real accounts from invented ones by when the refusals start. Evicts the oldest
 * entry when full (an attacker flooding invented addresses only ages out other invented addresses).
 */
const SYNTHETIC_LOCKOUT = {
  limit: ACCOUNT_LOCKOUT.limit,
  windowSecs: ACCOUNT_LOCKOUT.windowMs / 1000,
  prefix: "auth-unknown-account",
  critical: true,
  overflow: "evict-oldest",
} as const;

const isBuild = process.env.NEXT_PHASE === "phase-production-build";

if (isBuild && !process.env.AUTH_SECRET) {
  process.env.AUTH_SECRET = "build-time-secret-only";
}
if (!isBuild) validateAuthSecret();

const oauthProviders = [...((authConfig.providers ?? []) as any[])];

const config = {
  adapter: isBuild ? undefined : PrismaAdapter(db),
  ...authConfig,
  pages: {
    signIn: "/login",
  },
  providers: [
    ...oauthProviders,
    Nodemailer({
      server: {
        host: "",
        port: 0,
        auth: { user: "", pass: "" },
      },
      from: "",
      async sendVerificationRequest({ identifier: email, url }) {
        await sendSignInEmail({ email, url });
      },
    }),
    Credentials({
      credentials: {
        email: { label: "Email", type: "email" },
        password: { label: "Password", type: "password" },
        otp: { label: "One-time code", type: "text" },
      },
      async authorize(credentials, req) {
        if (!credentials?.email || !credentials?.password) return null;

        const email = credentials.email as string;
        const ip = getClientIp(req);
        const userAgent = (req as any)?.headers?.get?.("user-agent") ?? null;

        const logAttempt = async (success: boolean, userId?: string, failReason?: string) => {
          if (isBuild) return;
          try {
            await db.loginAttempt.create({ data: { email, userId, success, failReason, ip, userAgent } });
          } catch { /* never crash auth on log failure */ }
        };

        const normalizedEmail = email.trim().toLowerCase();
        // Addresses are stored lower-case since the email-change normalization;
        // older rows keep their spelling, so try the exact form first.
        const user =
          (await db.user.findUnique({ where: { email } })) ??
          (normalizedEmail && normalizedEmail !== email ? await db.user.findUnique({ where: { email: normalizedEmail } }) : null);

        if (!user?.password) {
          // Indistinguishable from a real account: same throttle (a refused attempt writes no audit
          // row and skips bcrypt, like a locked account) and one bcrypt verification either way.
          if (!isBuild && !checkRateLimit(`email:${createHash("sha256").update(normalizedEmail).digest("hex").slice(0, 32)}`, SYNTHETIC_LOCKOUT).success) return null;
          await bcrypt.compare(String(credentials.password), DUMMY_PASSWORD_HASH);
          await logAttempt(false, undefined, "no_account");
          return null;
        }

        // Per-account lockout (persisted, across IPs): reserve an attempt before any password or
        // OTP check; a locked account is refused like a wrong password and writes no audit row
        // (anonymous traffic must not mean unbounded inserts). Released again on full success.
        const reservation = isBuild ? null : await reserveLoginAttempt(user.id);
        if (!isBuild && !reservation) return null;

        const passwordsMatch = await bcrypt.compare(credentials.password as string, user.password);
        if (!passwordsMatch) { await logAttempt(false, user.id, "password"); return null; }

        if (user.twoFactorEnabled) {
          const otp = String(credentials.otp || "").trim();
          if (!otp && user.twoFactorSecret) {
            // Correct password, code still to come: not a guess, so the attempt is given back and the
            // form is told to ask for the code (this replaces the old unauthenticated
            // /api/auth/credentials-status lookup that revealed which addresses exist and use 2FA).
            if (!isBuild) await releaseLoginAttempt(user.id, "web", reservation);
            throw new OtpRequiredError();
          }
          if (!user.twoFactorSecret || !await consumeTotpToken(user.id, user.twoFactorSecret, otp)) {
            await logAttempt(false, user.id, "otp");
            return null;
          }
        }

        if (!isBuild) await releaseLoginAttempt(user.id, "web", reservation);
        await logAttempt(true, user.id);
        return user as any;
      },
    }),
  ],
  callbacks: {
    ...authConfig.callbacks,
    async signIn({ user, account }: { user: any; account?: any }) {
      if (
        account?.type === "credentials" ||
        account?.provider === "nodemailer" ||
        account?.type === "oauth" ||
        account?.type === "oidc"
      ) {
        if (!user.email) {
          return false;
        }

        const existingUser = await db.user.findUnique({
          where: { email: user.email as string },
        });

        if (existingUser?.isActive === false) {
          return false;
        }

        if (!existingUser) {
          const settings = await db.globalSettings.findUnique({ where: { id: "global" } });
          if (settings && !settings.registrationsEnabled && await db.user.count() > 0) return false;
          // Persist the default only for an empty installation. Legacy installs
          // with users and no settings retain their previous open policy.
          if (!settings && await db.user.count() === 0) {
            await db.globalSettings.upsert({
              where: { id: "global" }, update: {},
              create: { id: "global", registrationsEnabled: false },
            });
          }
        }
      }
      return true;
    },
    async session({ session, token }: { session: any; token: any }) {
      if (token.sub && session.user) {
        session.user.id = token.sub;
        session.user.role = token.role as string;
      }
      session.authenticatedAt = token.authenticatedAt;
      return session;
    },
    async jwt({ token, trigger }: { token: any; trigger?: string }) {
      // JWT iat is refreshed when cookies rotate; retain the actual sign-in time.
      if (trigger === "signIn" || trigger === "signUp") token.authenticatedAt = Math.floor(Date.now() / 1000);
      if (!token.sub) return token;

      const user = (await db.user.findUnique({
        where: { id: token.sub },
        select: { isActive: true, sessionVersion: true, role: true, email: true },
      })) as any;

      if (!user || !user.isActive) {
        const { sub: _sub, role: _role, sv: _sv, email: _email, name: _name, picture: _picture, ...rest } = token;
        return rest;
      }
      if (user) {
        // Invalidate token if sessionVersion changed (password change, 2FA toggle)
        if (typeof token.sv === "number" && token.sv !== user.sessionVersion) {
          const { sub: _sub, role: _role, sv: _sv, email: _email, name: _name, picture: _picture, ...rest } = token;
          return rest;
        }
        token.role = user.role;
        token.sv = user.sessionVersion;
        // Follow a (step-up protected) email change without a re-login.
        if (user.email) token.email = user.email;
      }

      return token;
    },
  },
  trustHost: true,
};

const authData = NextAuth(config as any);

export const handlers = authData.handlers;
export const auth = authData.auth;
export const signIn = authData.signIn;
export const signOut = authData.signOut;
