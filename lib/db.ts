import { PrismaClient } from "@prisma/client";
import { PrismaBetterSqlite3 } from "@prisma/adapter-better-sqlite3";
import { PrismaPg } from "@prisma/adapter-pg";
import pg from "pg";

const aliases: Record<string, string> = {
  sqlite: "sqlite",
  file: "sqlite",
  postgres: "postgresql",
  postgresql: "postgresql",
};

// Shared provider resolution so other modules (e.g. lib/search.ts, lib/search-indexes.ts)
// agree with the adapter on whether we're running against SQLite or PostgreSQL.
export function getDatabaseProvider(): "sqlite" | "postgresql" {
  return (aliases[(process.env.DATABASE_PROVIDER ?? "sqlite").toLowerCase()] as "sqlite" | "postgresql" | undefined) ?? "sqlite";
}

function getDatabaseUrl() {
  const url = process.env.DATABASE_URL;
  if (!url) return "file:./dev.db";
  if (url.startsWith("file:./")) return url;
  if (url.startsWith("file:") && !url.startsWith("file:/")) return `file:${url.substring(5)}`;
  return url;
}

function createAdapter() {
  const provider = aliases[(process.env.DATABASE_PROVIDER ?? "sqlite").toLowerCase()] ?? "sqlite";
  const url = getDatabaseUrl();

  if (provider === "sqlite") {
    const filePath = url.replace(/^file:/, "");
    return new PrismaBetterSqlite3({ url: filePath });
  }

  return new PrismaPg(new pg.Pool({ connectionString: url }));
}

const globalForPrisma = globalThis as unknown as { prisma: PrismaClient };

const createDb = () =>
  new PrismaClient({
    adapter: createAdapter(),
    log: ["error"],
  });

export const db = globalForPrisma.prisma || createDb();

if (process.env.NODE_ENV !== "production") globalForPrisma.prisma = db;
