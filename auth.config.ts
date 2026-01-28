import type { NextAuthConfig } from "next-auth";
import Credentials from "next-auth/providers/credentials";

export default {
    providers: [
        Credentials({}),
    ],
    session: { strategy: "jwt" },
    callbacks: {
        authorized({ auth, request: { nextUrl } }) {
            const isLoggedIn = !!auth?.user;
            const isApiAuthRoute = nextUrl.pathname.startsWith("/api/auth");
            const isPublicRoute = ["/login", "/register", "/setup"].includes(nextUrl.pathname);

            if (isApiAuthRoute) return true;

            if (isPublicRoute) {
                if (isLoggedIn) return Response.redirect(new URL("/", nextUrl));
                return true;
            }

            return isLoggedIn;
        },
    },
} satisfies NextAuthConfig;
