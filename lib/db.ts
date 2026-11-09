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

// Pragmas applied once per SQLite connection (Postgres is never touched).
// - WAL: readers no longer block on writers (persisted in the DB file).
// - synchronous=NORMAL: safe with WAL, avoids an fsync per commit.
// - busy_timeout: wait for a competing writer instead of failing with SQLITE_BUSY.
// - temp_store/cache_size: keep sort/temp b-trees in memory, ~20 MB page cache.
// foreign_keys is already ON by default in better-sqlite3.
export const SQLITE_PRAGMAS = [
  "journal_mode = WAL",
  "synchronous = NORMAL",
  "busy_timeout = 5000",
  "temp_store = MEMORY",
  "cache_size = -20000",
] as const;

export function applySqlitePragmas(client: { pragma: (source: string) => unknown }) {
  for (const pragma of SQLITE_PRAGMAS) {
    try {
      client.pragma(pragma);
    } catch (err) {
      console.warn(`[db] Failed to apply SQLite PRAGMA ${pragma}`, err);
    }
  }
}

function createAdapter() {
  const provider = aliases[(process.env.DATABASE_PROVIDER ?? "sqlite").toLowerCase()] ?? "sqlite";
  const url = getDatabaseUrl();

  if (provider === "sqlite") {
    const filePath = url.replace(/^file:/, "");
    const factory = new PrismaBetterSqlite3({ url: filePath });
    // Hook the factory so pragmas are set synchronously on the raw better-sqlite3
    // connection before Prisma issues any query (no startup race).
    const connect = factory.connect.bind(factory);
    factory.connect = async () => {
      const adapter = await connect();
      applySqlitePragmas((adapter as unknown as { client: { pragma: (s: string) => unknown } }).client);
      return adapter;
    };
    return factory;
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
