// FEEDFERRET_DB_SYNC=migrate (default) startup step, called by scripts/db-migrate.sh.
// Plain ESM; runs in the runner image (globally installed Prisma CLI via PRISMA_CMD).
//
//   1. Postgres: wait for the DB, decide PRISMA_PG_TRGM (scripts/db-state.mjs ensurePgTrgm).
//   2. Prepare prisma/schema.generated.prisma (+ the frozen baseline for legacy databases).
//   3. Postgres: take a session advisory lock on a dedicated connection, so parallel
//      starts (replicas, a restart overlapping a deploy) adopt/migrate one at a time.
//      The state is read AFTER the lock is held. SQLite: single process, no lock.
//   4. legacy (db-push database without _prisma_migrations) -> adopt the history:
//        a) DB == current schema  -> mark migrations applied (beyond the baseline only
//                                    pure-DDL ones, or ones the operator confirmed)
//        b) DB == baseline        -> mark the baseline applied; deploy runs the rest
//        c) DB = baseline - additive gap -> db push the baseline (no --accept-data-loss), then b
//        d) DB between baseline and current, additive gap to current, every newer
//           migration pure DDL/confirmed -> db push the current schema, then a
//        else stop, nothing changed.
//   5. prisma migrate deploy, release the lock, log-only drift check.
//
// Fails closed: any unexpected result exits 1 so the app never starts on an unverified schema.
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { prepareSchema } from "./prepare-prisma-schema.mjs";
import { baseline as BASELINE_MIGRATION, pureDdlViolations } from "./migration-utils.mjs";
import { classifyTables, ensurePgTrgm, listTables, normalizeProvider, waitForPostgres } from "./db-state.mjs";

const CONFIG = "prisma/startup.config.mjs";
// Fixed key for pg_advisory_lock (bytes of "FFMIGRAT"); distinct from Prisma's own migrate lock.
const LOCK_KEY = "5063819808149225812";
const LOCK_WAIT_MS = Number(process.env.FEEDFERRET_DB_LOCK_TIMEOUT_MS || 10 * 60_000);

const ts = () => new Date().toISOString().replace("T", " ").slice(0, 19);
const log = (message) => console.log(`[${ts()}] ${message}`);
class StartupError extends Error {}
const fail = (message) => { throw new StartupError(message); };

const env = { ...process.env };
delete env.PRISMA_SCHEMA_OVERRIDE; // dev/CI only; never at startup
const provider = normalizeProvider(env.DATABASE_PROVIDER);
const isPg = provider === "postgresql";
const url = env.DATABASE_URL || "file:./dev.db";
const [prismaBin, ...prismaPre] = (env.PRISMA_CMD || "prisma").trim().split(/\s+/);
const migrationsDir = join("prisma", "migrations", provider);
const confirmed = new Set((env.FEEDFERRET_DB_ADOPT_CONFIRM || "").split(/[\s,]+/).filter(Boolean));

/**
 * Run the Prisma CLI. `capture` returns the output instead of streaming it.
 * @param {string[]} args @param {{ capture?: boolean, override?: string }} [options]
 */
function prisma(args, { capture = false, override } = {}) {
  const [sub1, sub2, ...rest] = args;
  const argv = [...prismaPre, sub1, sub2, "--config", CONFIG, ...rest];
  const result = spawnSync(prismaBin, argv, {
    env: override ? { ...env, PRISMA_SCHEMA_OVERRIDE: override } : env,
    encoding: "utf8",
    stdio: capture ? ["ignore", "pipe", "pipe"] : "inherit",
  });
  if (result.error) fail(`Could not run ${prismaBin}: ${result.error.message}`);
  return {
    status: result.status ?? 1,
    out: capture ? `${result.stdout}${result.stderr}`.trim() : "",
    stdout: capture ? result.stdout : "",
  };
}

const diffArgs = (target) => ["migrate", "diff", "--from-config-datasource", "--to-schema", target];
/** 0 = same, 2 = different; anything else fails. */
function compare(target, label) {
  const { status, out } = prisma([...diffArgs(target), "--exit-code"], { capture: true });
  if (status !== 0 && status !== 2) {
    console.log(out);
    fail(`Comparing the database with the ${label} schema failed (exit ${status}).`);
  }
  return { same: status === 0, out };
}
function diffSql(target) {
  // stdout only: the CLI writes "Loaded Prisma config ..." etc. to stderr.
  const { status, out, stdout } = prisma([...diffArgs(target), "--script"], { capture: true });
  if (status !== 0) { console.log(out); fail("Could not compute the SQL diff."); }
  return stdout;
}
function pushTo(target, label) {
  if (prisma(["db", "push"], { override: target }).status !== 0) {
    fail(`db push to the ${label} schema failed (Prisma refused data loss or the change could not be applied). Nothing was marked as migrated. See docs/database.md.`);
  }
  const after = compare(target, label);
  if (!after.same) {
    console.log(after.out);
    fail(`The database still differs from the ${label} schema after db push. Nothing was marked as migrated. Fix the difference above (or start with FEEDFERRET_DB_SYNC=push) and restart.`);
  }
}

function migrationNames() {
  if (!existsSync(migrationsDir)) fail(`No migrations found in ${migrationsDir}.`);
  const names = readdirSync(migrationsDir, { withFileTypes: true })
    .filter((e) => e.isDirectory() && existsSync(join(migrationsDir, e.name, "migration.sql")))
    .map((e) => e.name).sort();
  if (names[0] !== BASELINE_MIGRATION) fail(`${migrationsDir} must start with ${BASELINE_MIGRATION}.`);
  return names;
}
/** Newer migrations that cannot be adopted without running them (not pure DDL, not confirmed). */
function unadoptable(names) {
  return names.slice(1).filter((name) => !confirmed.has(name))
    .map((name) => ({ name, problems: pureDdlViolations(readFileSync(join(migrationsDir, name, "migration.sql"), "utf8")) }))
    .filter((m) => m.problems.length);
}
function refuseUnadoptable(blocked, why) {
  for (const m of blocked) console.log(`  ${m.name}:\n    - ${m.problems.join("\n    - ")}`);
  fail(`${why} The migration(s) above contain more than plain DDL (data changes/backfills or other statements), so they cannot be marked as applied without running them. Nothing was changed.
   To proceed: take a backup, apply the non-DDL part of each migration by hand (or confirm it is not needed for this database), then start with
   FEEDFERRET_DB_ADOPT_CONFIRM=${blocked.map((m) => m.name).join(",")}
   once and unset it afterwards. See docs/database.md ("Migrations at startup").`);
}
function resolveApplied(name) {
  if (prisma(["migrate", "resolve", "--applied", name]).status !== 0) fail(`migrate resolve --applied ${name} failed.`);
}

function adoptLegacy() {
  log("🧭 Legacy database (created by db push, no migration history): adopting the migration history.");
  const names = migrationNames();
  const baselinePath = resolve("prisma/baseline.generated.prisma");
  writeFileSync(baselinePath, prepareSchema(readFileSync("prisma/baseline.schema.prisma", "utf8"), provider, { skipTrgm: env.PRISMA_PG_TRGM === "0" }));
  const currentPath = resolve("prisma/schema.generated.prisma");

  let adopt = compare(currentPath, "current").same ? "all" : null;
  if (adopt === "all") {
    const blocked = unadoptable(names);
    if (blocked.length) refuseUnadoptable(blocked, "The database matches the current schema, but newer migrations may also change data.");
  } else {
    const toBaseline = compare(baselinePath, "baseline");
    if (toBaseline.same) {
      adopt = "baseline";
    } else {
      log("⚠️ The database differs from the baseline schema:");
      console.log(toBaseline.out);
      const baselineSql = diffSql(baselinePath);
      if (!pureDdlViolations(baselineSql).length) {
        log("➕ Additive gap to the baseline only: applying it with db push (no --accept-data-loss).");
        pushTo(baselinePath, "baseline");
        adopt = "baseline";
      } else {
        const currentSql = names.length > 1 ? diffSql(currentPath) : null;
        if (currentSql !== null && !pureDdlViolations(currentSql).length) {
          const blocked = unadoptable(names);
          if (blocked.length) refuseUnadoptable(blocked, "The database is ahead of the baseline (newer objects already pushed).");
          log("➕ Database is ahead of the baseline (newer objects already pushed); the gap to the current schema is additive and all newer migrations are plain DDL: applying it with db push (no --accept-data-loss).");
          pushTo(currentPath, "current");
          adopt = "all";
        } else {
          console.log(currentSql ?? baselineSql);
          fail(`Adopting this database needs destructive changes (see SQL above). Nothing was changed.
   To proceed: take a backup, start once with FEEDFERRET_DB_SYNC=push (refuses data loss; use
   push-unsafe only if you accept the listed losses), then unset FEEDFERRET_DB_SYNC and restart.
   See docs/database.md ("Migrations at startup").`);
        }
      }
    }
  }

  if (adopt === "all") {
    log(`✅ Legacy database matches the current schema: marking all ${names.length} migration(s) as applied.`);
    for (const name of names) resolveApplied(name);
  } else {
    log("✅ Legacy database matches the baseline.");
    resolveApplied(BASELINE_MIGRATION);
    log(`✅ Baseline ${BASELINE_MIGRATION} marked as applied.`);
  }
}

async function acquireLock() {
  const client = await waitForPostgres(url, { log });
  const deadline = Date.now() + LOCK_WAIT_MS;
  let waiting = false;
  for (;;) {
    const { rows } = await client.query(`SELECT pg_try_advisory_lock(${LOCK_KEY}::bigint) AS ok`);
    if (rows[0].ok) {
      if (waiting) log("🔓 Schema lock acquired.");
      return client;
    }
    if (Date.now() > deadline) {
      await client.end().catch(() => {});
      fail(`Another instance held the schema lock for more than ${LOCK_WAIT_MS / 1000}s. Not starting.`);
    }
    if (!waiting) log("⏳ Another instance is updating the schema; waiting for the schema lock...");
    waiting = true;
    await new Promise((r) => setTimeout(r, 2000));
  }
}

async function main() {
  if (isPg) {
    try {
      env.PRISMA_PG_TRGM = await ensurePgTrgm(url, { log });
    } catch (error) {
      fail(`${error?.message ?? error}. Not starting (a transient error must not disable the trigram indexes).`);
    }
    if (env.PRISMA_PG_TRGM === "1") log("✅ pg_trgm extension available.");
  }
  const skipTrgm = isPg && env.PRISMA_PG_TRGM === "0";
  writeFileSync("prisma/schema.generated.prisma", prepareSchema(readFileSync("prisma/schema.prisma", "utf8"), provider, { skipTrgm }));
  log(`Prepared Prisma schema for ${provider}${skipTrgm ? " (without pg_trgm indexes)" : ""}.`);

  const lock = isPg ? await acquireLock() : null;
  try {
    let state;
    try {
      state = classifyTables(await listTables({ provider, url, configDir: resolve("prisma"), client: lock ?? undefined }));
    } catch (error) {
      fail(`Could not inspect the database (DATABASE_URL / DATABASE_PROVIDER?): ${error?.message ?? error}`);
    }
    log(`🔎 Database state: ${state}`);
    if (state === "legacy") adoptLegacy();

    log("🔄 Applying migrations (prisma migrate deploy)...");
    if (prisma(["migrate", "deploy"]).status !== 0) {
      fail('prisma migrate deploy failed. The database was NOT started. Check the error above; for a failed migration see docs/database.md ("Recovering from a failed migration").');
    }
  } finally {
    if (lock) {
      await lock.query(`SELECT pg_advisory_unlock(${LOCK_KEY}::bigint)`).catch(() => {});
      await lock.end().catch(() => {});
    }
  }

  if ((env.FEEDFERRET_DB_DRIFT_CHECK ?? "1") !== "0") {
    const { status, out } = prisma([...diffArgs(resolve("prisma/schema.generated.prisma")), "--exit-code"], { capture: true });
    if (status === 0) log("✅ Database schema matches prisma/schema.prisma.");
    else if (status === 2) { log("⚠️ Schema drift: the database differs from prisma/schema.prisma (not changed automatically):"); console.log(out); }
    else { log(`⚠️ Drift check could not run (exit ${status}); continuing.`); console.log(out.split("\n").slice(-5).join("\n")); }
  }
}

main().catch((error) => {
  log(`❌ ${error instanceof StartupError ? error.message : `Unexpected error: ${error?.stack ?? error}`}`);
  process.exit(1);
});
