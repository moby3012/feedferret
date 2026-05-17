import NextAuth from "next-auth";
import { PrismaAdapter } from "@auth/prisma-adapter";
import { db } from "@/lib/db";
import authConfig from "./auth.config";
import Credentials from "next-auth/providers/credentials";
import Nodemailer from "next-auth/providers/nodemailer";
import bcrypt from "bcryptjs";
import { verifyTotpToken } from "@/lib/totp";
import { sendSignInEmail } from "@/lib/mail";

const isBuild =
  process.env.NEXT_PHASE === "phase-production-build" ||
  (process.env.NODE_ENV === "production" && !process.env.AUTH_SECRET);

if (isBuild && !process.env.AUTH_SECRET) {
  process.env.AUTH_SECRET = "build-time-secret-only";
}

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
        const ip = (req as any)?.headers?.get?.("x-forwarded-for")?.split(",")[0]?.trim()
          ?? (req as any)?.headers?.get?.("x-real-ip")
          ?? null;
        const userAgent = (req as any)?.headers?.get?.("user-agent") ?? null;

        const logAttempt = async (success: boolean, userId?: string, failReason?: string) => {
          if (isBuild) return;
          try {
            await db.loginAttempt.create({ data: { email, userId, success, failReason, ip, userAgent } });
          } catch { /* never crash auth on log failure */ }
        };

        const user = await db.user.findUnique({ where: { email } });

        if (!user?.password) { await logAttempt(false, undefined, "no_account"); return null; }

        const passwordsMatch = await bcrypt.compare(credentials.password as string, user.password);
        if (!passwordsMatch) { await logAttempt(false, user.id, "password"); return null; }

        if (user.twoFactorEnabled) {
          const otp = String(credentials.otp || "");
          if (!user.twoFactorSecret || !verifyTotpToken(user.twoFactorSecret, otp)) {
            await logAttempt(false, user.id, "otp");
            return null;
          }
        }

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
        account?.type === "oauth"
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
          if (settings && !settings.registrationsEnabled) {
            return false;
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
      return session;
    },
    async jwt({ token }: { token: any }) {
      if (!token.sub) return token;

      const user = (await db.user.findUnique({
        where: { id: token.sub },
      })) as any;

      if (user) {
        if (user.isActive === false) {
          const { sub: _sub, ...rest } = token;
          return rest;
        }
        // Invalidate token if sessionVersion changed (password change, 2FA toggle)
        if (typeof token.sv === "number" && token.sv !== user.sessionVersion) {
          const { sub: _sub, ...rest } = token;
          return rest;
        }
        token.role = user.role;
        token.sv = user.sessionVersion;
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
