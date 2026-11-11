// Startup helper for scripts/db-migrate.sh (M11). Plain ESM, runs inside the runner image.
//
//   node scripts/db-state.mjs                  prints  empty | legacy | migrated
//   node scripts/db-state.mjs assert-additive  reads a SQL diff on stdin; exit 1 if destructive
//   node scripts/db-state.mjs assert-migrations-additive <dir>  exit 1 if a post-baseline migration is not additive
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

/** @param {{ provider?: string, url?: string, configDir?: string }} options */
export async function listTables({ provider, url, configDir = join(here, "..", "prisma") }) {
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
  const pg = (await importPackage("pg")).default;
  const client = new pg.Client({ connectionString: url, connectionTimeoutMillis: 15_000 });
  await client.connect();
  try {
    const { rows } = await client.query(
      "SELECT table_name FROM information_schema.tables WHERE table_schema = $1",
      [postgresSchema(url)],
    );
    return rows.map((row) => row.table_name);
  } finally {
    await client.end();
  }
}

/** @param {{ provider?: string, url?: string, configDir?: string }} options */
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
  if (command === "assert-additive") {
    const { assertSafeSql } = await import("./migration-utils.mjs");
    const sql = (await readStdin()).replace(/^[ \t]*-- ff:allow-destructive.*$/gm, "");
    assertSafeSql(sql, "legacy database -> schema diff");
    return;
  }
  if (command === "assert-migrations-additive") {
    // Every migration after the baseline must be plain additive SQL, so pushing the
    // current schema is equivalent to running them (no skipped data statements).
    const { assertSafeSql, baseline } = await import("./migration-utils.mjs");
    const dir = process.argv[3];
    if (!dir) throw new Error("Usage: assert-migrations-additive <migrations dir>");
    for (const name of readdirSync(dir, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name).sort()) {
      if (name === baseline) continue;
      // A reviewed `-- ff:allow-destructive` migration is fine for `migrate deploy`, but not
      // for adoption by push: its data statements/drops would be skipped or done differently.
      const sql = readFileSync(join(dir, name, "migration.sql"), "utf8").replace(/^[ \t]*-- ff:allow-destructive.*$/gm, "");
      assertSafeSql(sql, `${dir}/${name}`);
    }
    return;
  }
  throw new Error(`Unknown command "${command}" (use: state | assert-additive | assert-migrations-additive <dir>)`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch((error) => {
    console.error(`db-state: ${error?.message ?? error}`);
    process.exit(1);
  });
}
