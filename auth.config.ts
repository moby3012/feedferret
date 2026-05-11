import type { NextAuthConfig } from "next-auth";
import Credentials from "next-auth/providers/credentials";
import Github from "next-auth/providers/github";
import Google from "next-auth/providers/google";

export default {
    providers: [
        Google({
            clientId: process.env.GOOGLE_CLIENT_ID,
            clientSecret: process.env.GOOGLE_CLIENT_SECRET,
        }),
        Github({
            clientId: process.env.GITHUB_CLIENT_ID,
            clientSecret: process.env.GITHUB_CLIENT_SECRET,
        }),
        Credentials({}),
    ].filter(p => {
        if (p.id === "google") return !!process.env.GOOGLE_CLIENT_ID;
        if (p.id === "github") return !!process.env.GITHUB_CLIENT_ID;
        return true;
    }),
    session: { strategy: "jwt" },
    callbacks: {
        authorized({ auth, request: { nextUrl } }) {
            const isLoggedIn = !!auth?.user;
            const isApiAuthRoute = nextUrl.pathname.startsWith("/api/auth");
            const isPublicRoute =
                ["/login", "/register", "/setup"].includes(nextUrl.pathname) ||
                nextUrl.pathname.startsWith("/shared/search/");

            if (isApiAuthRoute) return true;

            if (isPublicRoute) {
                if (isLoggedIn) return Response.redirect(new URL("/", nextUrl));
                return true;
            }

            return isLoggedIn;
        },
    },
} satisfies NextAuthConfig;
