import NextAuth from "next-auth";
import { PrismaAdapter } from "@auth/prisma-adapter";
import { db } from "@/lib/db";
import authConfig from "./auth.config";
import Credentials from "next-auth/providers/credentials";
import Nodemailer from "next-auth/providers/nodemailer";
import bcrypt from "bcryptjs";
import nodemailer from "nodemailer";

// detect if we are in the build phase to avoid database calls
const isBuild = process.env.NEXT_PHASE === "phase-production-build" || process.env.NODE_ENV === "production" && !process.env.AUTH_SECRET;

// Ensure AUTH_SECRET is present during build to avoid AuthError crash
if (isBuild && !process.env.AUTH_SECRET) {
    process.env.AUTH_SECRET = "build-time-secret-only";
}

const config = {
    adapter: isBuild ? undefined : PrismaAdapter(db),
    ...authConfig,
    pages: {
        signIn: "/login",
    },
    providers: [
        Nodemailer({
            async sendVerificationRequest({ identifier: email, url }) {
                const settings = await db.globalSettings.findUnique({ where: { id: "global" } });

                if (!settings || !settings.mailServiceEnabled || !settings.smtpHost) {
                    console.error("Mail service is disabled or not configured.");
                    return;
                }

                const transporter = nodemailer.createTransport({
                    host: settings.smtpHost,
                    port: settings.smtpPort || 587,
                    secure: settings.smtpPort === 465,
                    auth: {
                        user: settings.smtpUser || undefined,
                        pass: settings.smtpPassword || undefined,
                    },
                });

                const { host } = new URL(url);
                const result = await transporter.sendMail({
                    to: email,
                    from: settings.smtpFrom || "noreply@feedferret.cloud",
                    subject: `Sign in to ${host}`,
                    text: `Sign in to ${host}\n${url}\n\n`,
                    html: `
                    <div style="background: #f9f9f9; padding: 20px; font-family: sans-serif;">
                      <div style="max-width: 600px; margin: 0 auto; background: white; padding: 40px; border-radius: 10px; box-shadow: 0 4px 6px rgba(0,0,0,0.05);">
                        <h1 style="color: #111; margin-bottom: 20px;">Sign in to ${host}</h1>
                        <p style="color: #444; font-size: 16px; line-height: 1.6;">Click the button below to sign in to your FeedFerret account. This link will expire in 24 hours.</p>
                        <a href="${url}" style="display: inline-block; background: #000; color: #fff; padding: 12px 30px; border-radius: 6px; text-decoration: none; font-weight: bold; margin-top: 20px;">Sign In</a>
                        <hr style="border: none; border-top: 1px solid #eee; margin: 30px 0;" />
                        <p style="color: #888; font-size: 12px;">If you didn't request this email, you can safely ignore it.</p>
                      </div>
                    </div>
                  `,
                });

                const failed = result.rejected.concat(result.pending).filter(Boolean);
                if (failed.length) {
                    throw new Error(`Email(s) (${failed.join(", ")}) could not be sent`);
                }
            },
        }),
        Credentials({
            async authorize(credentials) {
                if (!credentials?.email || !credentials?.password) return null;

                const user = await db.user.findUnique({
                    where: { email: credentials.email as string },
                });

                if (!user || user?.password === null) return null;

                const passwordsMatch = await bcrypt.compare(
                    credentials.password as string,
                    user.password
                );

                if (passwordsMatch) return user as any;

                return null;
            },
        }),
    ],
    callbacks: {
        ...authConfig.callbacks,
        async signIn({ user, account }: { user: any, account?: any }) {
            // If it's a new registration, check if registrations are enabled
            if (account?.type === "credentials" || account?.provider === "nodemailer" || account?.type === "oauth") {
                const existingUser = await db.user.findUnique({
                    where: { email: user.email as string },
                });

                if (!existingUser) {
                    const settings = await db.globalSettings.findUnique({ where: { id: "global" } });
                    if (settings && !settings.registrationsEnabled) {
                        return false; // Registering is disabled
                    }
                }
            }
            return true;
        },
        async session({ session, token }: { session: any, token: any }) {
            if (token.sub && session.user) {
                session.user.id = token.sub;
                session.user.role = token.role as string;
            }
            return session;
        },
        async jwt({ token }: { token: any }) {
            if (!token.sub) return token;

            const user = await db.user.findUnique({
                where: { id: token.sub },
            }) as any;

            if (user) {
                token.role = user.role;
            }

            return token;
        },
    },
    trustHost: true,
};

const authData = NextAuth({
    ...config,
    basePath: "/api/engine-auth",
});

export const handlers = authData.handlers;
export const auth = authData.auth;
export const signIn = authData.signIn;
export const signOut = authData.signOut;
