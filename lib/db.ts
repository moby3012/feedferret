import { withExternalIds } from "./external-id-store";
import { withSecretSealing } from "./secret-sealing";
import { PrismaClient } from "@prisma/client";
import { PrismaBetterSqlite3 } from "@prisma/adapter-better-sqlite3";
import { PrismaPg } from "@prisma/adapter-pg";
import pg from "pg";
import { getDatabaseProvider } from "./db-provider";

// Provider resolution lives in its own module so code that must not depend on a mocked
// `@/lib/db` (tests replace it with their own client) can still ask for the provider.
export { getDatabaseProvider } from "./db-provider";

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
  const provider = getDatabaseProvider();
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

const globalForPrisma = globalThis as unknown as { prisma: ReturnType<typeof createDb> };

// Secret columns are sealed on every write (security audit #2, M8 PR 5).
const createDb = () =>
  withSecretSealing(withExternalIds(new PrismaClient({
    adapter: createAdapter(),
    log: ["error"],
  })));

export const db = globalForPrisma.prisma || createDb();

if (process.env.NODE_ENV !== "production") globalForPrisma.prisma = db;
