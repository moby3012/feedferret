import type { NextAuthConfig } from "next-auth";
import Github from "next-auth/providers/github";
import Google from "next-auth/providers/google";

const autheliaProvider =
  process.env.AUTHELIA_CLIENT_ID &&
  process.env.AUTHELIA_CLIENT_SECRET &&
  process.env.AUTHELIA_ISSUER
    ? ({
        id: "authelia",
        name: process.env.AUTHELIA_PROVIDER_NAME || "Authelia",
        type: "oidc",
        issuer: process.env.AUTHELIA_ISSUER,
        clientId: process.env.AUTHELIA_CLIENT_ID,
        clientSecret: process.env.AUTHELIA_CLIENT_SECRET,
        checks: ["pkce", "state"],
        profile(profile: Record<string, unknown>) {
          return {
            id: String(profile.sub || profile.email || profile.preferred_username),
            name: String(profile.name || profile.preferred_username || profile.email || "Authelia User"),
            email: profile.email ? String(profile.email) : null,
            image: null,
          };
        },
      } as any)
    : null;

export default {
  pages: {
    signIn: "/login",
  },
  providers: [
    process.env.GOOGLE_CLIENT_ID && process.env.GOOGLE_CLIENT_SECRET
      ? Google({
          clientId: process.env.GOOGLE_CLIENT_ID,
          clientSecret: process.env.GOOGLE_CLIENT_SECRET,
        })
      : null,
    process.env.GITHUB_CLIENT_ID && process.env.GITHUB_CLIENT_SECRET
      ? Github({
          clientId: process.env.GITHUB_CLIENT_ID,
          clientSecret: process.env.GITHUB_CLIENT_SECRET,
        })
      : null,
    autheliaProvider,
  ].filter(Boolean),
  session: { strategy: "jwt" },
  callbacks: {
    authorized({ auth, request: { nextUrl } }) {
      const isLoggedIn = !!auth?.user;
      const isApiAuthRoute = nextUrl.pathname.startsWith("/api/auth");
      const isSetupRoute = nextUrl.pathname === "/setup";
      const isAuthPage = ["/login", "/register"].includes(nextUrl.pathname);
      const isSharedRoute = nextUrl.pathname.startsWith("/shared/search/");

      if (isApiAuthRoute || isSetupRoute || isSharedRoute) return true;

      if (isAuthPage) {
        if (isLoggedIn) return Response.redirect(new URL("/", nextUrl));
        return true;
      }

      return isLoggedIn;
    },
  },
} satisfies NextAuthConfig;
