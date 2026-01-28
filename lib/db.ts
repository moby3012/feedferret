import { PrismaClient } from "./prisma-client"

const globalForPrisma = global as unknown as { prisma: PrismaClient };

const getDatabaseUrl = () => {
    let url = process.env.DATABASE_URL;
    if (!url) return "file:/app/data/dev.db";

    if (url.startsWith("file:./")) {
        return `file:/app/${url.substring(7)}`;
    } else if (url.startsWith("file:") && !url.startsWith("file:/")) {
        // Handle file:data/dev.db or similar
        return `file:/app/${url.substring(5)}`;
    }
    return url;
};

export const db =
    globalForPrisma.prisma ||
    new PrismaClient({
        log: ["error"],
        datasources: process.env.NODE_ENV === "production" ? {
            db: {
                url: getDatabaseUrl(),
            },
        } : undefined,
    });

if (process.env.NODE_ENV !== "production") globalForPrisma.prisma = db;
