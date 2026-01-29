import { PrismaClient } from "@prisma/client"

const globalForPrisma = global as unknown as { prisma: PrismaClient };

const getDatabaseUrl = () => {
    let url = process.env.DATABASE_URL;
    if (!url) {
        // Use a relative path for build time to avoid OS-specific absolute path issues
        return "file:./dev.db";
    }

    if (url.startsWith("file:./")) {
        // Keep relative paths as is
        return url;
    } else if (url.startsWith("file:") && !url.startsWith("file:/")) {
        return `file:${url.substring(5)}`;
    }
    return url;
};

const createDb = () => {
    return new PrismaClient({
        log: ["error"],
        datasources: process.env.NODE_ENV === "production" ? {
            db: {
                url: getDatabaseUrl(),
            },
        } : undefined,
    });
};

export const db = globalForPrisma.prisma || createDb();

if (process.env.NODE_ENV !== "production") globalForPrisma.prisma = db;
