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
      async authorize(credentials) {
        if (!credentials?.email || !credentials?.password) return null;

        const user = await db.user.findUnique({
          where: { email: credentials.email as string },
        });

        if (!user?.password) return null;

        const passwordsMatch = await bcrypt.compare(
          credentials.password as string,
          user.password,
        );

        if (!passwordsMatch) return null;

        if (user.twoFactorEnabled) {
          const otp = String(credentials.otp || "");
          if (!user.twoFactorSecret || !verifyTotpToken(user.twoFactorSecret, otp)) {
            return null;
          }
        }

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
        token.role = user.role;
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
