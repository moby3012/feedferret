import authConfig from "./auth.config";
import NextAuth from "next-auth";

const { auth } = NextAuth({
    ...authConfig,
    basePath: "/api/engine-auth",
    secret: process.env.AUTH_SECRET || "dummy-secret-for-build-evaluation",
});

export default auth;

export const config = {
    matcher: ["/((?!api|_next/static|_next/image|favicon.ico|logo.svg).*)"],
};
