#!/usr/bin/env node
// Stored-secret maintenance (security audit #2, M8).
//
//   node scripts/secrets-cli.mjs status  [--json]
//   node scripts/secrets-cli.mjs migrate [--dry-run] [--batch N] [--json]
//   node scripts/secrets-cli.mjs rotate  [--dry-run] [--batch N] [--json]
//   (also: pnpm cli secrets:status | secrets:migrate | secrets:rotate)
//
// status:  counts every secret column by stored format and key id (read-only).
// migrate: re-seals legacy plaintext / v1 values with the current key (v2).
// rotate:  re-seals everything not sealed with the current key, including v2
//          values under a key listed in FEEDFERRET_ENCRYPTION_KEYS_OLD.
// migrate/rotate are idempotent and batched, compare-and-swap every row (a
// concurrent app write wins) and keep updatedAt. None of the commands ever
// prints a secret value. Exit code 2 when any value cannot be decrypted with
// the configured FEEDFERRET_ENCRYPTION_KEY / AUTH_SECRET / FEEDFERRET_ENCRYPTION_KEYS_OLD.
import { readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { SECRET_COLUMNS, classifySecret, classifyWebhookJson, loadKeyring } from "../lib/secret-box-core.mjs";
import { DEFAULT_BATCH_SIZE, migrateSecrets } from "../lib/secret-migration-core.mjs";

const BATCH = 500;

/**
 * Import a package from a source checkout or from the Next standalone image,
 * where some packages (the Prisma driver adapters) are not hoisted into
 * node_modules but only present in node_modules/.pnpm/<name>@<version>/.
 */
async function importPackage(name) {
  try {
    return await import(name);
  } catch (error) {
    if (error?.code !== "ERR_MODULE_NOT_FOUND") throw error;
    const store = join(dirname(fileURLToPath(import.meta.url)), "..", "node_modules", ".pnpm");
    const prefix = `${name.replace("/", "+")}@`;
    let entries = [];
    try {
      entries = readdirSync(store).filter((entry) => entry.startsWith(prefix)).sort();
    } catch {
      // no pnpm store next to the script
    }
    const found = entries.at(-1);
    if (!found) throw error;
    // Only the ESM entry is traced into the image: load it by file URL.
    const dir = join(store, found, "node_modules", name);
    const pkg = JSON.parse(readFileSync(join(dir, "package.json"), "utf8"));
    const root = pkg.exports?.["."] ?? pkg.exports;
    const entry = (typeof root?.import === "string" ? root.import : root?.import?.default) ?? pkg.module ?? pkg.main ?? "index.js";
    return import(pathToFileURL(join(dir, entry)).href);
  }
}

export async function createPrisma() {
  const { PrismaClient } = await import("@prisma/client");
  const provider = (process.env.DATABASE_PROVIDER ?? "sqlite").toLowerCase();
  const url = process.env.DATABASE_URL || "file:./dev.db";
  if (provider === "postgres" || provider === "postgresql") {
    const { PrismaPg } = await importPackage("@prisma/adapter-pg");
    const pg = (await import("pg")).default;
    return new PrismaClient({ adapter: new PrismaPg(new pg.Pool({ connectionString: url })) });
  }
  const { PrismaBetterSqlite3 } = await importPackage("@prisma/adapter-better-sqlite3");
  return new PrismaClient({ adapter: new PrismaBetterSqlite3({ url: url.replace(/^file:/, "") }) });
}

/** @param {any} prisma @param {{ model: string, column: string }} column */
async function* storedValues(prisma, column) {
  let cursor;
  for (;;) {
    const rows = await prisma[column.model].findMany({
      where: { [column.column]: { not: null } },
      select: { id: true, [column.column]: true },
      orderBy: { id: "asc" },
      take: BATCH,
      ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
    });
    for (const row of rows) yield row[column.column];
    if (rows.length < BATCH) return;
    cursor = rows[rows.length - 1].id;
  }
}

/**
 * @param {any} prisma
 * @param {ReturnType<typeof loadKeyring>} keyring
 */
export async function collectSecretStatus(prisma, keyring) {
  const columns = [];
  for (const column of SECRET_COLUMNS) {
    /** @type {Record<string, number>} */
    const counts = {};
    for await (const stored of storedValues(prisma, column)) {
      const buckets = column.json === "webhooks"
        ? classifyWebhookJson(stored, keyring)
        : [classifySecret(stored, column, keyring)];
      for (const bucket of buckets) {
        if (bucket === "empty") continue;
        counts[bucket] = (counts[bucket] ?? 0) + 1;
      }
    }
    columns.push({ column: `${column.model}.${column.column}`, legacy: column.legacy, counts });
  }
  const undecryptable = columns.reduce(
    (sum, c) => sum + Object.entries(c.counts)
      .filter(([bucket]) => bucket === "undecryptable" || bucket === "malformed" || bucket.endsWith(":unknown") || bucket === "invalid-json")
      .reduce((s, [, n]) => s + n, 0),
    0,
  );
  return {
    keys: {
      current: { kid: keyring.current.kid, source: keyring.current.source },
      old: keyring.old.map((k) => ({ kid: k.kid })),
    },
    columns,
    undecryptable,
  };
}

function printStatus(status) {
  console.log(`Current key id: ${status.keys.current.kid} (from ${status.keys.current.source})`);
  console.log(`Old key ids:    ${status.keys.old.map((k) => k.kid).join(", ") || "none"}`);
  console.log("");
  const rows = status.columns.map((c) => ({
    column: c.column,
    legacy: c.legacy,
    ...Object.fromEntries(Object.entries(c.counts).sort(([a], [b]) => a.localeCompare(b))),
  }));
  console.table(rows);
  console.log("Buckets: plaintext / v1 = legacy formats (re-sealed by `secrets:migrate` and at app start);");
  console.log("v2:<kid>:current|old = new format; undecryptable / malformed / :unknown = cannot be read with the configured keys.");
  if (status.undecryptable > 0) {
    console.error(`\n${status.undecryptable} stored secret(s) cannot be decrypted with the configured keys.`);
  }
}

function printMigration(report) {
  const verb = report.dryRun ? "would re-seal" : "re-sealed";
  console.log(`secrets:${report.mode}${report.dryRun ? " (dry run, nothing written)" : ""}`);
  console.log(`Current key id: ${report.keys.current} (from ${report.keys.source}); old key ids: ${report.keys.old.join(", ") || "none"}`);
  console.log("");
  console.table(report.columns.map((c) => ({
    column: c.column,
    scanned: c.scanned,
    current: c.current,
    [verb]: c.resealed,
    ...(report.mode === "migrate" ? { "old key (rotate)": c.oldKey } : {}),
    undecryptable: c.undecryptable,
    conflicts: c.conflicts,
  })));
  const t = report.totals;
  console.log(`Total: ${t.scanned} scanned, ${t.current} already current, ${t.resealed} ${verb}, ${t.undecryptable} undecryptable, ${t.conflicts} changed concurrently (skipped).`);
  if (report.mode === "migrate" && t.oldKey) console.log(`${t.oldKey} value(s) are sealed with an old key: run secrets:rotate to move them to the current key.`);
  console.log(`OAuth account tokens ${report.dryRun ? "to clear" : "cleared"}: ${report.oauthTokensCleared}`);
  for (const p of report.problems) console.error(`  undecryptable: ${p.column} row ${p.id} (${p.reason})`);
  if (report.problemsTruncated) console.error("  … more rows (list truncated)");
  if (report.mode === "rotate" && !report.dryRun && t.undecryptable === 0 && report.keys.old.length) {
    console.log([
      "",
      "Stored secrets no longer need an old key once `secrets:status` shows no `:old` bucket.",
      "That alone does NOT make it safe to remove FEEDFERRET_ENCRYPTION_KEYS_OLD: old keys also verify",
      "signed tokens that live outside the database (GReader client tokens, Telegram mark-read links,",
      "valid 7 days). Keep them until those have expired / clients re-authenticated; see docs/security.md.",
    ].join("\n"));
  }
}

/** @param {string[]} rest */
function parseFlags(rest) {
  const flags = { json: false, dryRun: false, batchSize: DEFAULT_BATCH_SIZE };
  for (let i = 0; i < rest.length; i += 1) {
    const arg = rest[i];
    if (arg === "--json") flags.json = true;
    else if (arg === "--dry-run") flags.dryRun = true;
    else if (arg === "--batch" || arg.startsWith("--batch=")) {
      const raw = arg.includes("=") ? arg.split("=")[1] : rest[++i];
      const n = Number(raw);
      if (!Number.isInteger(n) || n < 1 || n > 10_000) throw new Error("--batch must be an integer between 1 and 10000");
      flags.batchSize = n;
    } else throw new Error(`Unknown option: ${arg}`);
  }
  return flags;
}

export async function main(argv = process.argv.slice(2)) {
  const [cmd = "help", ...rest] = argv[0] === "--" ? argv.slice(1) : argv;
  if (cmd === "status") {
    const keyring = loadKeyring(process.env);
    const prisma = await createPrisma();
    try {
      const status = await collectSecretStatus(prisma, keyring);
      if (rest.includes("--json")) console.log(JSON.stringify(status, null, 2));
      else printStatus(status);
      return status.undecryptable > 0 ? 2 : 0;
    } finally {
      await prisma.$disconnect();
    }
  }
  if (cmd === "migrate" || cmd === "rotate") {
    const flags = parseFlags(rest);
    const keyring = loadKeyring(process.env);
    if (keyring.current.source === "build") throw new Error("Set FEEDFERRET_ENCRYPTION_KEY or AUTH_SECRET.");
    const prisma = await createPrisma();
    try {
      const report = await migrateSecrets(prisma, { keyring, mode: cmd, dryRun: flags.dryRun, batchSize: flags.batchSize });
      if (flags.json) console.log(JSON.stringify(report, null, 2));
      else printMigration(report);
      return report.totals.undecryptable > 0 ? 2 : 0;
    } finally {
      await prisma.$disconnect();
    }
  }
  console.log([
    "FeedFerret secrets CLI",
    "",
    "Commands:",
    "  status  [--json]                      counts per stored format and key id (never prints values)",
    "  migrate [--dry-run] [--batch N] [--json]  re-seal legacy plaintext / v1 values with the current key",
    "  rotate  [--dry-run] [--batch N] [--json]  re-seal everything not sealed with the current key",
    "",
  ].join("\n"));
  return cmd === "help" ? 0 : 1;
}

const invokedDirectly = import.meta.url === `file://${process.argv[1]}` || process.argv[1]?.endsWith("/secrets-cli.mjs");
if (invokedDirectly) {
  main().then(
    (code) => { process.exitCode = code; },
    (error) => { console.error(error instanceof Error ? error.message : String(error)); process.exitCode = 1; },
  );
}
