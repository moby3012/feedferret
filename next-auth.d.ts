import { DefaultSession } from "next-auth";

declare module "next-auth" {
    interface Session {
        authenticatedAt?: number;
        user: {
            id: string;
            role: string;
        } & DefaultSession["user"];
    }

    interface User {
        role: string;
    }
}

declare module "next-auth/jwt" {
    interface JWT {
        role: string;
    }
}

declare module "@auth/core/adapters" {
    interface AdapterUser {
        role: string;
    }
}
