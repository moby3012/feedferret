// Startup schema step (M11): scripts/db-state.mjs + the scripts/db-migrate.sh decision logic.
// The real Prisma CLI paths (legacy adoption, idempotency, push fallback) run against real
// SQLite/Postgres databases in scripts/test-migrations.mjs (CI "migrations" job). Here the
// shell logic runs with a fake Prisma CLI so every branch, including the failure ones, is
// covered quickly and without a database server.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import { chmodSync, cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import Database from "better-sqlite3";
import {
  classifyTables,
  detectState,
  lockWaitMs,
  normalizeProvider,
  postgresSchema,
  sqliteFilePath,
} from "../../scripts/db-state.mjs";

const repo = resolve(__dirname, "../..");
let work: string;

function sqliteDb(name: string, sql: string) {
  const file = join(work, name);
  const db = new Database(file) as unknown as { exec(sql: string): void; close(): void };
  db.exec(sql);
  db.close();
  return file;
}

beforeAll(() => {
  // Isolated copy: db-migrate.sh writes prisma/*.generated.prisma relative to its cwd.
  work = mkdtempSync(join(tmpdir(), "ff-db-migrate-"));
  mkdirSync(join(work, "scripts"));
  mkdirSync(join(work, "prisma"));
  for (const f of ["db-migrate.sh", "db-migrate.mjs", "db-common.sh", "db-sync.sh", "db-state.mjs", "migration-utils.mjs", "prepare-prisma-schema.mjs"]) {
    cpSync(join(repo, "scripts", f), join(work, "scripts", f));
  }
  for (const f of ["schema.prisma", "baseline.schema.prisma"]) cpSync(join(repo, "prisma", f), join(work, "prisma", f));
  // Only the baseline: the scenarios below add their own later migrations, so the expectations must
  // not depend on how many real migrations the repo has accumulated since.
  cpSync(join(repo, "prisma", "migrations"), join(work, "prisma", "migrations"), {
    recursive: true,
    filter: (src) => !/[\\/]\d{14}_[^\\/]+$/.test(src) || /[\\/]00000000000000_init$/.test(src),
  });
  symlinkSync(join(repo, "node_modules"), join(work, "node_modules"));
});
afterAll(() => rmSync(work, { recursive: true, force: true }));

describe("db-state", () => {
  it("classifies by migration history first, then the legacy User table", () => {
    expect(classifyTables([])).toBe("empty");
    expect(classifyTables(["article_fts", "something"])).toBe("empty");
    expect(classifyTables(["User", "Feed"])).toBe("legacy");
    expect(classifyTables(["User", "_prisma_migrations"])).toBe("migrated");
    expect(classifyTables(["_prisma_migrations"])).toBe("migrated");
  });

  it("normalizes providers and rejects unknown ones", () => {
    expect(normalizeProvider(undefined)).toBe("sqlite");
    expect(normalizeProvider("file")).toBe("sqlite");
    expect(normalizeProvider("Postgres")).toBe("postgresql");
    expect(() => normalizeProvider("mysql")).toThrow(/Unsupported/);
  });

  it("resolves relative SQLite URLs like the Prisma CLI (against the config dir)", () => {
    expect(sqliteFilePath("file:./dev.db", "/app/prisma")).toBe("/app/prisma/dev.db");
    expect(sqliteFilePath("file:dev.db", "/app/prisma")).toBe("/app/prisma/dev.db");
    expect(sqliteFilePath("file:/app/data/dev.db", "/app/prisma")).toBe("/app/data/dev.db");
    expect(sqliteFilePath("file:/app/data/dev.db?connection_limit=1", "/x")).toBe("/app/data/dev.db");
  });

  it("reads the Postgres schema from ?schema=", () => {
    expect(postgresSchema("postgresql://u:p@h:5432/db?schema=public")).toBe("public");
    expect(postgresSchema("postgresql://u:p@h:5432/db?schema=ff")).toBe("ff");
    expect(postgresSchema("postgresql://u:p@h:5432/db")).toBe("public");
  });

  it("detects the state of real SQLite files (missing file = empty)", async () => {
    const empty = sqliteDb("state-empty.db", "SELECT 1");
    const legacy = sqliteDb("state-legacy.db", 'CREATE TABLE "User"(id TEXT)');
    const migrated = sqliteDb("state-migrated.db", 'CREATE TABLE "User"(id TEXT); CREATE TABLE _prisma_migrations(id TEXT)');
    expect(await detectState({ provider: "sqlite", url: `file:${empty}` })).toBe("empty");
    expect(await detectState({ provider: "sqlite", url: `file:${legacy}` })).toBe("legacy");
    expect(await detectState({ provider: "sqlite", url: `file:${migrated}` })).toBe("migrated");
    expect(await detectState({ provider: "sqlite", url: `file:${join(work, "nope.db")}` })).toBe("empty");
    expect(await detectState({ provider: "sqlite", url: "file:./state-legacy.db", configDir: work })).toBe("legacy");
  });

  it("validates FEEDFERRET_DB_LOCK_TIMEOUT_MS (positive integer ms, else default + warning)", () => {
    const warnings: string[] = [];
    const warn = (m: string) => warnings.push(m);
    expect(lockWaitMs(undefined, warn)).toBe(600_000);
    expect(lockWaitMs("", warn)).toBe(600_000);
    expect(lockWaitMs("30000", warn)).toBe(30_000);
    expect(warnings).toEqual([]);
    for (const bad of ["0", "-5", "1.5", "abc", "1e3", "Infinity", "NaN", "99999999999999999999"]) {
      expect(lockWaitMs(bad, warn)).toBe(600_000);
    }
    expect(warnings).toHaveLength(8);
    expect(warnings[0]).toMatch(/Ignoring invalid FEEDFERRET_DB_LOCK_TIMEOUT_MS/);
  });

  it("assert-additive rejects destructive SQL and accepts additive SQL", () => {
    const check = (sql: string) =>
      spawnSync("node", ["scripts/db-state.mjs", "assert-additive"], { cwd: work, input: sql, encoding: "utf8" }).status;
    expect(check('ALTER TABLE "User" ADD COLUMN "x" TEXT;')).toBe(0);
    expect(check("-- This is an empty migration.")).toBe(0);
    expect(check('ALTER TABLE "User" DROP COLUMN "x";')).toBe(1);
    expect(check('-- RedefineTables\nCREATE TABLE "new_User" (id TEXT);')).toBe(1);
    expect(check('DROP INDEX "User_email_key";')).toBe(1);
    expect(check('INSERT INTO "User" (id) VALUES (\'x\');')).toBe(1);
    expect(check('-- ff:allow-destructive marked\nUPDATE "User" SET "x" = 1;')).toBe(1);
  });
});

describe("db-migrate.sh (fake Prisma CLI)", () => {
  // Fake `prisma`: logs every call with the schema override it saw; scripted exit codes.
  //   FAKE_DIFF_RCS   space-separated exit codes for successive `migrate diff --exit-code`
  //   FAKE_SQL        output of `migrate diff --script` (FAKE_SQL_BASELINE for the baseline target)
  //   FAKE_PUSH_RC / FAKE_DEPLOY_RC / FAKE_RESOLVE_RC
  const FAKE = `#!/bin/sh
echo "override=\${PRISMA_SCHEMA_OVERRIDE:-} args=$*" >> "$FAKE_LOG"
case "$*" in
  *"migrate diff"*"--exit-code"*)
    n=$(cat "$FAKE_LOG.n" 2>/dev/null || echo 1); echo $((n + 1)) > "$FAKE_LOG.n"
    rc=$(echo "$FAKE_DIFF_RCS" | cut -d' ' -f"$n"); echo "[*] Changed the User table"; exit "\${rc:-0}" ;;
  *"migrate diff"*"baseline.generated"*"--script"*) printf '%s\\n' "\${FAKE_SQL_BASELINE:-$FAKE_SQL}"; exit 0 ;;
  *"migrate diff"*"--script"*) printf '%s\\n' "$FAKE_SQL"; exit 0 ;;
  *"db push"*) exit "\${FAKE_PUSH_RC:-0}" ;;
  *"migrate deploy"*) echo "No pending migrations to apply."; exit "\${FAKE_DEPLOY_RC:-0}" ;;
  *"migrate resolve"*) exit "\${FAKE_RESOLVE_RC:-0}" ;;
esac
exit 0
`;
  let n = 0;

  function runStartup(dbFile: string, env: Record<string, string> = {}) {
    const log = join(work, `fake-${++n}.log`);
    const fake = join(work, "fake-prisma.sh");
    writeFileSync(fake, FAKE);
    chmodSync(fake, 0o755);
    const r = spawnSync("sh", ["scripts/db-migrate.sh"], {
      cwd: work,
      encoding: "utf8",
      env: {
        PATH: process.env.PATH,
        HOME: process.env.HOME,
        PRISMA_CMD: fake,
        FAKE_LOG: log,
        DATABASE_PROVIDER: "sqlite",
        DATABASE_URL: `file:${dbFile}`,
        PRISMA_SCHEMA_OVERRIDE: "/must/be/unset.prisma",
        ...env,
      } as unknown as NodeJS.ProcessEnv,
    });
    let calls: string[] = [];
    try {
      calls = readFileSync(log, "utf8").trim().split("\n").filter(Boolean);
    } catch {
      // no prisma calls
    }
    return { status: r.status, out: `${r.stdout}${r.stderr}`, calls };
  }
  const has = (calls: string[], s: string) => calls.some((c) => c.includes(s));

  it("skip touches nothing; unknown modes fail closed", () => {
    const db = sqliteDb("skip.db", "SELECT 1");
    const skip = runStartup(db, { FEEDFERRET_DB_SYNC: "skip" });
    expect(skip.status).toBe(0);
    expect(skip.calls).toEqual([]);
    const bad = runStartup(db, { FEEDFERRET_DB_SYNC: "yolo" });
    expect(bad.status).toBe(1);
    expect(bad.out).toMatch(/Unknown FEEDFERRET_DB_SYNC/);
    expect(bad.calls).toEqual([]);
  });

  it("push never accepts data loss; push-unsafe does, with a warning", () => {
    const db = sqliteDb("push.db", "SELECT 1");
    const push = runStartup(db, { FEEDFERRET_DB_SYNC: "push" });
    expect(push.status).toBe(0);
    expect(push.calls).toHaveLength(1);
    expect(push.calls[0]).toMatch(/override= args=db push --config prisma\/startup.config.mjs\s*$/);
    const unsafe = runStartup(db, { FEEDFERRET_DB_SYNC: "PUSH-UNSAFE" });
    expect(unsafe.status).toBe(0);
    expect(unsafe.out).toMatch(/WARNING: FEEDFERRET_DB_SYNC=push-unsafe/);
    expect(unsafe.calls[0]).toContain("db push --config prisma/startup.config.mjs --accept-data-loss");
  });

  it("empty database: migrate deploy only, plus the drift check", () => {
    const r = runStartup(sqliteDb("empty.db", "SELECT 1"));
    expect(r.status).toBe(0);
    expect(r.out).toMatch(/Database state: empty/);
    expect(has(r.calls, "migrate resolve")).toBe(false);
    expect(has(r.calls, "db push")).toBe(false);
    expect(has(r.calls, "migrate deploy --config prisma/startup.config.mjs")).toBe(true);
    expect(r.calls.every((c) => c.startsWith("override= "))).toBe(true);
  });

  const norm = (calls: string[]) =>
    calls.map((c) => c.replace(/ --config \S+/, "").replace(/\S*baseline.generated.prisma/, "BASELINE").replace(/\S*schema.generated.prisma/, "CURRENT"));
  const DRIFT = "override= args=migrate diff --from-config-datasource --to-schema CURRENT --exit-code";

  it("legacy database already at the current schema: every migration marked applied, no push", () => {
    const r = runStartup(sqliteDb("legacy-current.db", 'CREATE TABLE "User"(id TEXT)'), { FAKE_DIFF_RCS: "0 0" });
    expect(r.status).toBe(0);
    expect(r.out).toMatch(/matches the current schema: marking all 1 migration/);
    expect(norm(r.calls)).toEqual([
      "override= args=migrate diff --from-config-datasource --to-schema CURRENT --exit-code",
      "override= args=migrate resolve --applied 00000000000000_init",
      "override= args=migrate deploy",
      DRIFT,
    ]);
    expect(readFileSync(join(work, "prisma/baseline.generated.prisma"), "utf8")).toMatch(/provider = "sqlite"/);
  });

  it("legacy database matching the baseline (behind current): resolve init only, deploy runs the rest", () => {
    const r = runStartup(sqliteDb("legacy-ok.db", 'CREATE TABLE "User"(id TEXT)'), { FAKE_DIFF_RCS: "2 0 0" });
    expect(r.status).toBe(0);
    expect(norm(r.calls)).toEqual([
      "override= args=migrate diff --from-config-datasource --to-schema CURRENT --exit-code",
      "override= args=migrate diff --from-config-datasource --to-schema BASELINE --exit-code",
      "override= args=migrate resolve --applied 00000000000000_init",
      "override= args=migrate deploy",
      DRIFT,
    ]);
  });

  it("legacy database with an additive gap: db push of the baseline (no data loss flag), re-diff, resolve", () => {
    const r = runStartup(sqliteDb("legacy-add.db", 'CREATE TABLE "User"(id TEXT)'), {
      FAKE_DIFF_RCS: "2 2 0 0",
      FAKE_SQL: 'ALTER TABLE "User" ADD COLUMN "ntfyToken" TEXT;',
    });
    expect(r.status).toBe(0);
    const push = r.calls.find((c) => c.includes("db push"))!;
    expect(push).toMatch(/^override=\S+\/prisma\/baseline.generated.prisma args=db push --config prisma\/startup.config.mjs$/);
    expect(push).not.toContain("accept-data-loss");
    const order = ["db push", "migrate resolve --config prisma/startup.config.mjs --applied 00000000000000_init", "migrate deploy"]
      .map((s) => r.calls.findIndex((c) => c.includes(s)));
    expect(order).toEqual([...order].sort((a, b) => a - b));
    expect(order.every((i) => i >= 0)).toBe(true);
  });

  it("legacy database needing destructive SQL: stops before any write", () => {
    const r = runStartup(sqliteDb("legacy-drop.db", 'CREATE TABLE "User"(id TEXT)'), {
      FAKE_DIFF_RCS: "2 2",
      FAKE_SQL: '-- RedefineTables\nDROP TABLE "User";',
    });
    expect(r.status).toBe(1);
    expect(r.out).toMatch(/needs destructive changes/);
    expect(r.out).toMatch(/FEEDFERRET_DB_SYNC=push/);
    expect(has(r.calls, "db push")).toBe(false);
    expect(has(r.calls, "migrate resolve")).toBe(false);
    expect(has(r.calls, "migrate deploy")).toBe(false);
  });

  it("legacy database: refused push or remaining diff never marks the baseline applied", () => {
    const db = sqliteDb("legacy-fail.db", 'CREATE TABLE "User"(id TEXT)');
    const add = 'ALTER TABLE "User" ADD COLUMN "x" TEXT;';
    const refused = runStartup(db, { FAKE_DIFF_RCS: "2 2", FAKE_SQL: add, FAKE_PUSH_RC: "1" });
    expect(refused.status).toBe(1);
    expect(refused.out).toMatch(/db push to the baseline schema failed/);
    expect(has(refused.calls, "migrate resolve")).toBe(false);

    const stillDiff = runStartup(db, { FAKE_DIFF_RCS: "2 2 2", FAKE_SQL: add });
    expect(stillDiff.status).toBe(1);
    expect(stillDiff.out).toMatch(/still differs from the baseline schema/);
    expect(has(stillDiff.calls, "migrate resolve")).toBe(false);

    for (const rcs of ["1", "2 1"]) {
      const diffError = runStartup(db, { FAKE_DIFF_RCS: rcs });
      expect(diffError.status).toBe(1);
      expect(has(diffError.calls, "migrate resolve")).toBe(false);
      expect(has(diffError.calls, "db push")).toBe(false);
    }
  });

  describe("database ahead of the baseline (a later migration's objects already pushed)", () => {
    const extra = () => join(work, "prisma/migrations/sqlite/20991231000000_newsletter");
    function withMigration(sql: string, fn: () => void) {
      mkdirSync(extra());
      writeFileSync(join(extra(), "migration.sql"), sql);
      try {
        fn();
      } finally {
        rmSync(extra(), { recursive: true, force: true });
      }
    }
    // Baseline push would have to drop the newer table; the current schema only adds.
    const toBaseline = 'DROP TABLE "Newsletter";';
    const toCurrent = 'ALTER TABLE "Newsletter" ADD COLUMN "x" TEXT;';

    it("exactly at the current schema: marks every migration applied, 0 pending", () => {
      withMigration('CREATE TABLE "Newsletter" ("id" TEXT NOT NULL PRIMARY KEY);', () => {
        const r = runStartup(sqliteDb("ahead-exact.db", 'CREATE TABLE "User"(id TEXT)'), { FAKE_DIFF_RCS: "0 0" });
        expect(r.status).toBe(0);
        expect(norm(r.calls).filter((c) => c.includes("resolve"))).toEqual([
          "override= args=migrate resolve --applied 00000000000000_init",
          "override= args=migrate resolve --applied 20991231000000_newsletter",
        ]);
        expect(has(r.calls, "db push")).toBe(false);
      });
    });

    it("between baseline and current with an additive gap: pushes the current schema, never the baseline", () => {
      withMigration('CREATE TABLE "Newsletter" ("id" TEXT NOT NULL PRIMARY KEY);', () => {
        const r = runStartup(sqliteDb("ahead-gap.db", 'CREATE TABLE "User"(id TEXT)'), {
          FAKE_DIFF_RCS: "2 2 0 0", FAKE_SQL_BASELINE: toBaseline, FAKE_SQL: toCurrent,
        });
        expect(r.status).toBe(0);
        expect(r.out).toMatch(/ahead of the baseline/);
        const pushes = r.calls.filter((c) => c.includes("db push"));
        expect(pushes).toHaveLength(1);
        expect(pushes[0]).toMatch(/^override=\S+\/prisma\/schema.generated.prisma args=db push --config prisma\/startup.config.mjs$/);
        expect(norm(r.calls).filter((c) => c.includes("resolve"))).toHaveLength(2);
      });
    });

    const backfill = 'ALTER TABLE "User" ADD COLUMN "plan" TEXT;\n-- ff:allow-destructive backfill\nUPDATE "User" SET "plan" = \'free\';';
    const seed = 'CREATE TABLE "Newsletter" ("id" TEXT NOT NULL PRIMARY KEY);\nINSERT INTO "Newsletter" ("id") VALUES (\'default\');';

    it("ahead with an UPDATE backfill migration: refuses to push/resolve (it would skip the backfill)", () => {
      withMigration(backfill, () => {
        const r = runStartup(sqliteDb("ahead-data.db", 'CREATE TABLE "User"(id TEXT)'), {
          FAKE_DIFF_RCS: "2 2", FAKE_SQL_BASELINE: toBaseline, FAKE_SQL: toCurrent,
        });
        expect(r.status).toBe(1);
        expect(r.out).toMatch(/more than plain DDL/);
        expect(r.out).toMatch(/UPDATE "User" SET/);
        expect(r.out).toMatch(/FEEDFERRET_DB_ADOPT_CONFIRM=20991231000000_newsletter/);
        expect(has(r.calls, "db push")).toBe(false);
        expect(has(r.calls, "migrate resolve")).toBe(false);
      });
    });

    it("at the current schema with an INSERT migration: refuses unless the operator confirms it", () => {
      withMigration(seed, () => {
        const db = sqliteDb("ahead-insert.db", 'CREATE TABLE "User"(id TEXT)');
        const refused = runStartup(db, { FAKE_DIFF_RCS: "0 0" });
        expect(refused.status).toBe(1);
        expect(refused.out).toMatch(/INSERT INTO "Newsletter"/);
        expect(has(refused.calls, "migrate resolve")).toBe(false);
        expect(has(refused.calls, "migrate deploy")).toBe(false);

        const wrongName = runStartup(db, { FAKE_DIFF_RCS: "0 0", FEEDFERRET_DB_ADOPT_CONFIRM: "20991231000000_other" });
        expect(wrongName.status).toBe(1);

        const ok = runStartup(db, { FAKE_DIFF_RCS: "0 0", FEEDFERRET_DB_ADOPT_CONFIRM: "20991231000000_newsletter" });
        expect(ok.status).toBe(0);
        expect(norm(ok.calls).filter((c) => c.includes("resolve"))).toEqual([
          "override= args=migrate resolve --applied 00000000000000_init",
          "override= args=migrate resolve --applied 20991231000000_newsletter",
        ]);
      });
    });

    it("behind the baseline with a data migration later: adopts only the baseline, deploy runs the rest", () => {
      withMigration(seed, () => {
        const r = runStartup(sqliteDb("baseline-insert.db", 'CREATE TABLE "User"(id TEXT)'), { FAKE_DIFF_RCS: "2 0 0" });
        expect(r.status).toBe(0);
        expect(norm(r.calls).filter((c) => c.includes("resolve"))).toEqual(["override= args=migrate resolve --applied 00000000000000_init"]);
        expect(has(r.calls, "migrate deploy")).toBe(true);
      });
    });

    it("refuses when the gap to the current schema is destructive too", () => {
      withMigration('CREATE TABLE "Newsletter" ("id" TEXT NOT NULL PRIMARY KEY);', () => {
        const r = runStartup(sqliteDb("ahead-drop.db", 'CREATE TABLE "User"(id TEXT)'), {
          FAKE_DIFF_RCS: "2 2", FAKE_SQL_BASELINE: toBaseline, FAKE_SQL: 'DROP TABLE "Legacy";',
        });
        expect(r.status).toBe(1);
        expect(has(r.calls, "db push")).toBe(false);
        expect(has(r.calls, "migrate resolve")).toBe(false);
      });
    });
  });

  it("re-runs an interrupted IDEMPOTENT migration (P3009) automatically, never any other", () => {
    const history = (name: string) => sqliteDb(`p3009-${name}.db`, `CREATE TABLE "User"(id TEXT);
      CREATE TABLE _prisma_migrations(id TEXT, migration_name TEXT, started_at TEXT, finished_at TEXT, rolled_back_at TEXT);
      INSERT INTO _prisma_migrations VALUES ('1', '00000000000000_init', '2026-01-01', '2026-01-01', NULL);
      INSERT INTO _prisma_migrations VALUES ('2', '${name}', '2026-01-02', NULL, NULL);`);
    const idempotent = runStartup(history("20261112170000_article_search_table"));
    expect(idempotent.status).toBe(0);
    expect(idempotent.out).toMatch(/20261112170000_article_search_table failed or was interrupted \(P3009\)/);
    expect(idempotent.calls.some((c) => c.includes("migrate resolve") && c.includes("--rolled-back") && c.includes("20261112170000_article_search_table"))).toBe(true);

    // A permanent failure (e.g. disk full) must not loop: after 3 automatic re-runs, stop and explain.
    const exhausted = sqliteDb("p3009-exhausted.db", `CREATE TABLE "User"(id TEXT);
      CREATE TABLE _prisma_migrations(id TEXT, migration_name TEXT, started_at TEXT, finished_at TEXT, rolled_back_at TEXT);
      INSERT INTO _prisma_migrations VALUES ('1', '20261112170000_article_search_table', '2026-01-01', NULL, '2026-01-01');
      INSERT INTO _prisma_migrations VALUES ('2', '20261112170000_article_search_table', '2026-01-02', NULL, '2026-01-02');
      INSERT INTO _prisma_migrations VALUES ('3', '20261112170000_article_search_table', '2026-01-03', NULL, '2026-01-03');
      INSERT INTO _prisma_migrations VALUES ('4', '20261112170000_article_search_table', '2026-01-04', NULL, NULL);`);
    const stopped = runStartup(exhausted, { FAKE_DEPLOY_RC: "1" });
    expect(stopped.status).toBe(1);
    expect(stopped.out).toMatch(/after 3 automatic re-runs; not retrying automatically/);
    expect(stopped.out).toMatch(/Postgres server log/);
    expect(has(stopped.calls, "migrate resolve")).toBe(false);

    const other = runStartup(history("20261111105727_feed_failing_since"));
    expect(other.out).not.toMatch(/was interrupted/);
    expect(has(other.calls, "migrate resolve")).toBe(false);
  });

  it("a failed migrate deploy stops the start; drift is only a warning", () => {
    const migrated = sqliteDb("migrated.db", 'CREATE TABLE "User"(id TEXT); CREATE TABLE _prisma_migrations(id TEXT)');
    const failed = runStartup(migrated, { FAKE_DEPLOY_RC: "1" });
    expect(failed.status).toBe(1);
    expect(failed.out).toMatch(/migrate deploy failed/);
    expect(has(failed.calls, "migrate resolve")).toBe(false);

    const drift = runStartup(migrated, { FAKE_DIFF_RCS: "2" });
    expect(drift.status).toBe(0);
    expect(drift.out).toMatch(/Schema drift/);

    const noDrift = runStartup(migrated, { FEEDFERRET_DB_DRIFT_CHECK: "0" });
    expect(noDrift.calls.some((c) => c.includes("migrate diff"))).toBe(false);
  });
});
