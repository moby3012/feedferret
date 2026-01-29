import NextAuth from "next-auth";
import { PrismaAdapter } from "@auth/prisma-adapter";
import { db } from "@/lib/db";
import authConfig from "./auth.config";
import Credentials from "next-auth/providers/credentials";
import Nodemailer from "next-auth/providers/nodemailer";
import bcrypt from "bcryptjs";

export const {
    handlers: { GET, POST },
    auth,
    signIn,
    signOut,
} = NextAuth({
    adapter: PrismaAdapter(db),
    ...authConfig,
    pages: {
        signIn: "/login",
    },
    providers: [
        Nodemailer({
            server: {
                host: process.env.SMTP_HOST,
                port: Number(process.env.SMTP_PORT),
                auth: {
                    user: process.env.SMTP_USER,
                    pass: process.env.SMTP_PASSWORD,
                },
            },
            from: process.env.EMAIL_FROM,
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
        async session({ session, token }) {
            if (token.sub && session.user) {
                session.user.id = token.sub;
                session.user.role = token.role as string;
            }
            return session;
        },
        async jwt({ token }) {
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
});
