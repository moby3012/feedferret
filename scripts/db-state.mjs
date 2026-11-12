// Startup helper for scripts/db-migrate.sh (M11). Plain ESM, runs inside the runner image.
//
//   node scripts/db-state.mjs                  prints  empty | legacy | migrated
//   node scripts/db-state.mjs assert-additive  reads a SQL diff on stdin; exit 1 unless pure DDL
//   node scripts/db-state.mjs ensure-trgm      prints 1 | 0 for PRISMA_PG_TRGM (Postgres)
//
// State (for DATABASE_PROVIDER / DATABASE_URL):
//   migrated  `_prisma_migrations` exists          -> `prisma migrate deploy`
//   legacy    `User` exists, no migration history  -> created by the old `db push` startup
//   empty     neither                              -> `migrate deploy` creates everything
//
// Any error (unreachable DB, unreadable file) exits non-zero so startup fails closed.
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));

/** @param {string[]} tables @returns {"empty" | "legacy" | "migrated"} */
export function classifyTables(tables) {
  const names = new Set(tables);
  if (names.has("_prisma_migrations")) return "migrated";
  if (names.has("User")) return "legacy";
  return "empty";
}

/** @param {string | undefined} provider */
export function normalizeProvider(provider) {
  const p = (provider || "sqlite").toLowerCase();
  if (p === "postgres" || p === "postgresql") return "postgresql";
  if (p === "sqlite" || p === "file") return "sqlite";
  throw new Error(`Unsupported DATABASE_PROVIDER="${provider}". Use sqlite or postgresql.`);
}

/**
 * The SQLite file the Prisma CLI uses for `url`. The CLI resolves relative `file:` URLs
 * against the directory of the config file (prisma/startup.config.mjs -> prisma/), so this
 * must do the same, or the state check would look at a different file than `migrate deploy`.
 * @param {string} url @param {string} configDir
 */
export function sqliteFilePath(url, configDir) {
  const raw = url.replace(/^file:/, "").replace(/\?.*$/, "");
  return isAbsolute(raw) ? raw : resolve(configDir, raw);
}

/** Postgres schema Prisma uses for `url` (`?schema=`, default public). @param {string} url */
export function postgresSchema(url) {
  try {
    return new URL(url).searchParams.get("schema") || "public";
  } catch {
    return "public";
  }
}

/**
 * Import a package from a source checkout or the Next standalone image, where some
 * packages are only present in node_modules/.pnpm/<name>@<version>/ (same approach as
 * scripts/secrets-cli.mjs).
 * @param {string} name
 */
async function importPackage(name) {
  try {
    return await import(name);
  } catch (error) {
    if (error?.code !== "ERR_MODULE_NOT_FOUND") throw error;
    const store = join(here, "..", "node_modules", ".pnpm");
    const prefix = `${name.replace("/", "+")}@`;
    let entries = [];
    try {
      entries = readdirSync(store).filter((entry) => entry.startsWith(prefix)).sort();
    } catch {
      // no pnpm store next to the script
    }
    const found = entries.at(-1);
    if (!found) throw error;
    const dir = join(store, found, "node_modules", name);
    const pkg = JSON.parse(readFileSync(join(dir, "package.json"), "utf8"));
    const root = pkg.exports?.["."] ?? pkg.exports;
    const entry = (typeof root?.import === "string" ? root.import : root?.import?.default) ?? pkg.main ?? "index.js";
    return import(pathToFileURL(join(dir, entry)).href);
  }
}

/** @param {{ provider?: string, url?: string, configDir?: string, client?: any }} options */
export async function listTables({ provider, url, configDir = join(here, "..", "prisma"), client = undefined }) {
  const p = normalizeProvider(provider);
  if (p === "sqlite") {
    const file = sqliteFilePath(url || "file:./dev.db", configDir);
    if (!existsSync(file)) return [];
    const Database = (await importPackage("better-sqlite3")).default;
    const db = new Database(file, { readonly: true, fileMustExist: true });
    try {
      return db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all().map((row) => row.name);
    } finally {
      db.close();
    }
  }
  if (!url) throw new Error("DATABASE_URL is required for PostgreSQL");
  const db = client ?? (await pgClient(url));
  try {
    const { rows } = await db.query(
      "SELECT table_name FROM information_schema.tables WHERE table_schema = $1",
      [postgresSchema(url)],
    );
    return rows.map((row) => row.table_name);
  } finally {
    if (!client) await db.end();
  }
}

/**
 * Migrations Prisma recorded as started but neither finished nor rolled back (the P3009 state
 * after a crash/kill mid-migration). Empty when there is no history table.
 */
export async function unfinishedMigrations({ provider, url, configDir = join(here, "..", "prisma"), client = undefined }) {
  const p = normalizeProvider(provider);
  const sql = "SELECT migration_name FROM _prisma_migrations WHERE finished_at IS NULL AND rolled_back_at IS NULL ORDER BY migration_name";
  if (p === "sqlite") {
    const file = sqliteFilePath(url || "file:./dev.db", configDir);
    if (!existsSync(file)) return [];
    const Database = (await importPackage("better-sqlite3")).default;
    const db = new Database(file, { readonly: true, fileMustExist: true });
    try {
      if (!db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = '_prisma_migrations'").get()) return [];
      return db.prepare(sql).all().map((row) => row.migration_name);
    } finally {
      db.close();
    }
  }
  const db = client ?? (await pgClient(url));
  try {
    const schema = postgresSchema(url);
    const { rows: exists } = await db.query("SELECT 1 FROM information_schema.tables WHERE table_schema = $1 AND table_name = '_prisma_migrations'", [schema]);
    if (!exists.length) return [];
    const { rows } = await db.query(sql.replace("FROM _prisma_migrations", `FROM "${schema.replace(/"/g, '""')}"._prisma_migrations`));
    return rows.map((row) => row.migration_name);
  } finally {
    if (!client) await db.end();
  }
}

const DEFAULT_LOCK_WAIT_MS = 10 * 60_000;
/**
 * FEEDFERRET_DB_LOCK_TIMEOUT_MS: positive integer milliseconds, else the default (with a warning).
 * @param {string | undefined} raw @param {(message: string) => void} [warn]
 */
export function lockWaitMs(raw, warn = () => {}) {
  if (raw === undefined || raw === "") return DEFAULT_LOCK_WAIT_MS;
  const value = Number(raw);
  if (/^\d+$/.test(String(raw).trim()) && Number.isSafeInteger(value) && value > 0) return value;
  warn(`⚠️ Ignoring invalid FEEDFERRET_DB_LOCK_TIMEOUT_MS=${JSON.stringify(raw)} (expected a positive integer of milliseconds); using ${DEFAULT_LOCK_WAIT_MS}.`);
  return DEFAULT_LOCK_WAIT_MS;
}

/** @param {string} url */
export async function pgClient(url) {
  const pg = (await importPackage("pg")).default;
  const client = new pg.Client({ connectionString: url, connectionTimeoutMillis: 15_000 });
  await client.connect();
  return client;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Connect, retrying while Postgres is starting/unreachable (default 30 x 2 s). @param {string} url */
export async function waitForPostgres(url, { attempts = Number(process.env.FEEDFERRET_DB_WAIT_ATTEMPTS || 30), delayMs = 2000, log = () => {} } = {}) {
  for (let i = 1; ; i++) {
    try {
      return await pgClient(url);
    } catch (error) {
      if (i >= attempts) throw new Error(`PostgreSQL not reachable after ${attempts} attempt(s): ${error?.message || error?.code || error}`);
      log(`   ... PostgreSQL not ready (${error?.code || error?.message}); retrying in ${delayMs / 1000}s`);
      await sleep(delayMs);
    }
  }
}

// Errors that mean "this role/server cannot have pg_trgm" (not transient).
const TRGM_UNAVAILABLE_CODES = new Set(["42501", "58P01", "0A000"]);
const TRGM_UNAVAILABLE_TEXT = /permission denied|must be owner|must have CREATE privilege|not available|could not open extension control file/i;
/** @param {{ code?: string, message?: string }} error */
export function isTrgmUnavailableError(error) {
  return TRGM_UNAVAILABLE_CODES.has(error?.code ?? "") || TRGM_UNAVAILABLE_TEXT.test(error?.message ?? "");
}

/**
 * Decide PRISMA_PG_TRGM ("1" | "0") for startup:
 *   extension already installed                    -> "1" (never drop existing indexes)
 *   CREATE EXTENSION succeeds                      -> "1"
 *   confirmed privilege/availability error and the
 *   extension is still not installed               -> "0"
 *   anything else (connection loss, ...)           -> retried, then thrown (startup fails)
 * @param {string} url
 */
export async function ensurePgTrgm(url, { attempts = 3, delayMs = 3000, log = () => {} } = {}) {
  let lastError;
  for (let i = 1; i <= attempts; i++) {
    let client;
    try {
      client = await waitForPostgres(url, { log });
      const installed = async () => (await client.query("SELECT 1 FROM pg_extension WHERE extname = 'pg_trgm'")).rowCount > 0;
      if (await installed()) return "1";
      try {
        await client.query("CREATE EXTENSION IF NOT EXISTS pg_trgm");
        return "1";
      } catch (error) {
        if (isTrgmUnavailableError(error) && !(await installed())) {
          log(`⚠️ Could not create the pg_trgm extension (${error.code ?? "?"}: ${error.message}); starting without trigram search indexes.`);
          return "0";
        }
        throw error;
      }
    } catch (error) {
      lastError = error;
      if (i < attempts) {
        log(`⚠️ Checking the pg_trgm extension failed (${error?.message || error?.code || error}); retrying.`);
        await sleep(delayMs);
      }
    } finally {
      await client?.end().catch(() => {});
    }
  }
  throw new Error(`Could not verify the pg_trgm extension: ${lastError?.message || lastError?.code || lastError}`);
}

/** @param {{ provider?: string, url?: string, configDir?: string, client?: any }} options */
export async function detectState(options) {
  return classifyTables(await listTables(options));
}

async function readStdin() {
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  return Buffer.concat(chunks).toString("utf8");
}

async function main() {
  const command = process.argv[2] || "state";
  if (command === "state") {
    console.log(await detectState({ provider: process.env.DATABASE_PROVIDER, url: process.env.DATABASE_URL }));
    return;
  }
  if (command === "ensure-trgm") {
    // stdout: 1 | 0 (for PRISMA_PG_TRGM); logs go to stderr.
    console.log(await ensurePgTrgm(process.env.DATABASE_URL, { log: (m) => console.error(m) }));
    return;
  }
  if (command === "assert-additive") {
    const { assertPureDdl } = await import("./migration-utils.mjs");
    assertPureDdl(await readStdin(), "legacy database -> schema diff");
    return;
  }
  throw new Error(`Unknown command "${command}" (use: state | ensure-trgm | assert-additive)`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch((error) => {
    console.error(`db-state: ${error?.message ?? error}`);
    process.exit(1);
  });
}
