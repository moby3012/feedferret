// Integration gate. SQLite uses temporary files; Postgres creates/drops uniquely
// named databases via MIGRATION_TEST_ADMIN_URL. Never point this at production.
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, join, resolve } from 'node:path';
import Database from 'better-sqlite3';
import pg from 'pg';
import { prepareSchema } from './prepare-prisma-schema.mjs';
import { prisma, baseline, migrationNames } from './migration-utils.mjs';
const provider = process.argv[2];
if (!['sqlite', 'postgresql'].includes(provider)) throw new Error('Usage: node scripts/test-migrations.mjs sqlite|postgresql');
const dir = mkdtempSync(join(tmpdir(), 'ff-migration-test-'));
const prefix = `ff_m11_${process.pid}_${Date.now()}`;
let admin;
const databases = [];
let role;
const env = { ...process.env, DATABASE_PROVIDER: provider };
async function database(label, owner) {
  if (provider === 'sqlite') return `file:${join(dir, `${label}.db`)}`;
  const name = `${prefix}_${label}`;
  await admin.query(`CREATE DATABASE "${name}"${owner ? ` OWNER "${owner}"` : ''}`);
  databases.push(name);
  const url = new URL(process.env.MIGRATION_TEST_ADMIN_URL);
  url.pathname = `/${name}`;
  if (owner) { url.username = owner; url.password = 'm11-test-only'; }
  return url.toString();
}
async function query(url, sql) {
  if (provider === 'sqlite') {
    const db = new Database(url.slice(5));
    try { return db.prepare(sql).all(); } finally { db.close(); }
  }
  const db = new pg.Client({ connectionString: url });
  await db.connect();
  try { return (await db.query(sql)).rows; } finally { await db.end(); }
}
async function execute(url, sql) {
  if (provider === 'sqlite') {
    const db = new Database(url.slice(5));
    try { db.exec(sql); } finally { db.close(); }
  } else { await query(url, sql); }
}
function run(args, extra = {}) { console.log(prisma(args, { ...env, ...extra })); }

// ── PR 3: startup (scripts/db-migrate.sh) against databases created by the old db push ──
const SQLITE_FTS_SQL = `CREATE VIRTUAL TABLE article_fts USING fts5(id UNINDEXED, title, content, excerpt, author, tokenize='trigram');
  CREATE TABLE article_fts_meta (id INTEGER PRIMARY KEY, backfilled_at TEXT);
  INSERT INTO article_fts_meta VALUES (1, 'preserve');
  CREATE TRIGGER article_fts_ai AFTER INSERT ON "Article" BEGIN
    INSERT INTO article_fts(rowid, id, title, content, excerpt, author)
    VALUES (new.rowid, new.id, new.title, new.content, new.excerpt, new.author);
  END;`;
const SEED_SQL = `INSERT INTO "User" (id, email, "updatedAt") VALUES ('m11-user', 'm11-startup@example.test', CURRENT_TIMESTAMP);
  INSERT INTO "Feed" (id, url, name, "userId", "updatedAt") VALUES ('m11-feed', 'https://example.test/feed.xml', 'Feed', 'm11-user', CURRENT_TIMESTAMP);
  INSERT INTO "Article" (id, "feedId", "userId", title, link, content, "publishedAt", "updatedAt")
    VALUES ('m11-article', 'm11-feed', 'm11-user', 'preserve this search row', 'https://example.test/a', 'body', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP);`;
async function tableNames(url) {
  return (provider === 'sqlite'
    ? await query(url, "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE 'article_fts_%' AND name <> 'article_fts' ORDER BY name")
    : await query(url, "SELECT table_name AS name FROM information_schema.tables WHERE table_schema = 'public' AND table_type = 'BASE TABLE' ORDER BY table_name"))
    .map((row) => row.name).filter((name) => name !== '_prisma_migrations');
}
async function fingerprint(url) {
  const counts = {};
  // Only non-empty tables: a later additive migration may create new (empty) tables during the
  // upgrade, which is not a data change; a table that lost its rows still disappears from `counts`.
  for (const name of await tableNames(url)) {
    // Derived projection is populated by the search migration; verify it separately.
    if (name === 'ArticleSearch') continue;
    const n = Number((await query(url, `SELECT count(*) AS n FROM "${name}"`))[0].n);
    if (n > 0) counts[name] = n;
  }
  return JSON.stringify({
    counts,
    user: await query(url, 'SELECT id, email FROM "User" ORDER BY id'),
    search: provider === 'sqlite'
      ? { objects: await query(url, "SELECT type, name, sql FROM sqlite_master WHERE name LIKE 'article_fts%' ORDER BY name"),
          fts: await query(url, 'SELECT id, title FROM article_fts ORDER BY id'),
          meta: await query(url, 'SELECT * FROM article_fts_meta') }
      : {}, // GIN indexes move to ArticleSearch; application data must stay identical.
  });
}
async function migrationRows(url) {
  const exists = provider === 'sqlite'
    ? await query(url, "SELECT name FROM sqlite_master WHERE name = '_prisma_migrations'")
    : await query(url, "SELECT table_name FROM information_schema.tables WHERE table_schema = 'public' AND table_name = '_prisma_migrations'");
  if (!exists.length) return null;
  return (await query(url, 'SELECT migration_name FROM _prisma_migrations WHERE finished_at IS NOT NULL AND rolled_back_at IS NULL ORDER BY migration_name')).map((row) => row.migration_name);
}
function startup(url, extra = {}) {
  const result = spawnSync('sh', ['scripts/db-migrate.sh'], {
    encoding: 'utf8',
    env: {
      ...env, ...extra, DATABASE_URL: url, SHADOW_DATABASE_URL: '',
      // Must be ignored by startup (it unsets it); a bogus path proves that.
      PRISMA_SCHEMA_OVERRIDE: '/nonexistent/override.prisma',
      PATH: `${resolve('node_modules/.bin')}${delimiter}${process.env.PATH}`,
    },
  });
  const output = `${result.stdout}${result.stderr}`;
  console.log(output);
  return { status: result.status, output };
}
function startupAsync(url, extra = {}) {
  return new Promise((done) => {
    const child = spawn('sh', ['scripts/db-migrate.sh'], {
      env: {
        ...env, ...extra, DATABASE_URL: url, SHADOW_DATABASE_URL: '',
        PRISMA_SCHEMA_OVERRIDE: '/nonexistent/override.prisma',
        PATH: `${resolve('node_modules/.bin')}${delimiter}${process.env.PATH}`,
      },
    });
    let output = '';
    child.stdout.on('data', (d) => { output += d; });
    child.stderr.on('data', (d) => { output += d; });
    child.on('close', (status) => { console.log(output); done({ status, output }); });
  });
}
// Mirrors ensurePostgresTrigramIndexes() in lib/search-indexes.ts (one statement per call: CONCURRENTLY).
async function finishSearchIndexSwap(url) {
  for (const column of ['title', 'content', 'excerpt', 'author', 'entities']) {
    await query(url, `CREATE INDEX CONCURRENTLY IF NOT EXISTS "ArticleSearch_${column}_trgm_idx" ON "ArticleSearch" USING GIN ("${column}" gin_trgm_ops)`);
  }
  for (const column of ['title', 'content', 'excerpt', 'author', 'entities']) {
    await query(url, `DROP INDEX CONCURRENTLY IF EXISTS "Article_${column}_trgm_idx"`);
  }
}
function expect(condition, message) { if (!condition) throw new Error(`startup: ${message}`); }
async function legacyDatabase(label, legacySchema) {
  const url = await database(label);
  if (provider === 'postgresql') await execute(url, 'CREATE EXTENSION pg_trgm');
  run(['db', 'push'], { DATABASE_URL: url, PRISMA_SCHEMA_OVERRIDE: legacySchema, SHADOW_DATABASE_URL: '' });
  await execute(url, SEED_SQL);
  if (provider === 'sqlite') {
    await execute(url, SQLITE_FTS_SQL);
    await execute(url, `INSERT INTO "Article" (id, "feedId", "userId", title, link, content, "publishedAt", "updatedAt")
      VALUES ('m11-article-2', 'm11-feed', 'm11-user', 'second search row', 'https://example.test/b', 'body', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`);
  }
  return url;
}
async function startupUpgradeChecks(legacySchema) {
  const expected = migrationNames('prisma/migrations', provider);

  // 1. Legacy db-push database: adopted, data/search objects untouched, idempotent.
  const url = await legacyDatabase('startup', legacySchema);
  if (provider === 'sqlite') expect((await query(url, 'SELECT count(*) AS n FROM article_fts'))[0].n === 1, 'FTS trigger not active in seed');
  const before = await fingerprint(url);
  let r = startup(url);
  expect(r.status === 0, `legacy upgrade exited ${r.status}`);
  expect(/Legacy database matches the (current schema|baseline)/.test(r.output), 'legacy path not taken');
  expect(!/db push/.test(r.output.replace(/created by db push/g, '')), 'legacy DB matching the baseline must not be pushed');
  expect(JSON.stringify(await migrationRows(url)) === JSON.stringify(expected), `_prisma_migrations should list ${expected}`);
  expect((await migrationRows(url)).length >= 1 && (await migrationRows(url))[0] === baseline, 'baseline row missing');
  expect(before === await fingerprint(url), 'legacy upgrade changed row counts or search objects');
  expect(Number((await query(url, 'SELECT count(*) AS n FROM "ArticleSearch"'))[0].n) ===
    Number((await query(url, 'SELECT count(*) AS n FROM "Article"'))[0].n), 'search projection backfill incomplete');
  expect(/Database schema matches prisma\/schema.prisma/.test(r.output), 'drift check did not report a clean schema');
  if (provider === 'postgresql') {
    // Populated database: the migration leaves the GIN swap to the app (no index build/drop
    // under the deploy). Do what lib/search-indexes.ts does in the background, then expect a clean schema.
    expect(/except the search index swap/.test(r.output), 'populated DB: swap should be pending for the app');
    expect((await query(url, "SELECT 1 FROM pg_indexes WHERE indexname LIKE 'Article\\_%\\_trgm\\_idx'")).length === 5, 'migration must not drop Article indexes on a populated DB');
    await finishSearchIndexSwap(url);
  }

  r = startup(url);
  expect(r.status === 0 && /Database state: migrated/.test(r.output), 'second start not on the migrated path');
  expect(/No pending migrations to apply/.test(r.output), 'second start should report no pending migrations');
  expect(!/db push|Legacy database/.test(r.output), 'second start must not db push');
  expect(before === await fingerprint(url), 'second start changed data');

  // 2. Rollback switch: db push after migrate keeps the migration history and the data.
  r = startup(url, { FEEDFERRET_DB_SYNC: 'push' });
  expect(r.status === 0 && /already in sync/.test(r.output), 'FEEDFERRET_DB_SYNC=push did not find the DB in sync');
  expect(JSON.stringify(await migrationRows(url)) === JSON.stringify(expected), 'db push removed _prisma_migrations');
  expect(before === await fingerprint(url), 'db push fallback changed data');
  r = startup(url);
  expect(r.status === 0 && /No pending migrations to apply/.test(r.output), 'migrate after push fallback failed');

  // 3. skip and unknown modes.
  r = startup(url, { FEEDFERRET_DB_SYNC: 'skip' });
  expect(r.status === 0 && /not touching the database schema/.test(r.output), 'skip mode');
  r = startup(url, { FEEDFERRET_DB_SYNC: 'yolo' });
  expect(r.status !== 0, 'unknown FEEDFERRET_DB_SYNC must fail closed');

  // 4. Older legacy database (missing a nullable column): additive gap is pushed, then adopted.
  const older = await legacyDatabase('startup_older', legacySchema);
  await execute(older, 'ALTER TABLE "User" DROP COLUMN "ntfyToken"');
  r = startup(older);
  expect(r.status === 0 && /Additive gap to the baseline only/.test(r.output), `additive legacy upgrade exited ${r.status}`);
  expect(JSON.stringify(await migrationRows(older)) === JSON.stringify(expected), 'additive legacy: wrong history');
  expect((await query(older, 'SELECT count(*) AS n FROM "User"'))[0].n == 1, 'additive legacy lost users');

  // 5. Legacy database that would need a destructive change: fail closed, nothing changed.
  const extra = await legacyDatabase('startup_destructive', legacySchema);
  await execute(extra, `ALTER TABLE "User" ADD COLUMN "legacyOnly" TEXT; UPDATE "User" SET "legacyOnly" = 'keep me'`);
  const extraBefore = await fingerprint(extra);
  r = startup(extra);
  expect(r.status !== 0, 'destructive legacy diff must stop the start');
  expect(/needs destructive changes/.test(r.output), 'missing operator message for destructive diff');
  expect(await migrationRows(extra) === null, 'destructive legacy DB must not be marked as migrated');
  expect(extraBefore === await fingerprint(extra), 'destructive legacy DB was modified');
  expect((await query(extra, 'SELECT "legacyOnly" FROM "User"'))[0].legacyOnly === 'keep me', 'legacy column data lost');

  // 6. db-push install that is already at the CURRENT schema (ahead of the baseline once
  //    later migrations exist): every migration is marked applied, nothing pending.
  const current = await database('startup_current');
  if (provider === 'postgresql') await execute(current, 'CREATE EXTENSION pg_trgm');
  run(['db', 'push'], { DATABASE_URL: current, PRISMA_SCHEMA_OVERRIDE: schema, SHADOW_DATABASE_URL: '' });
  await execute(current, SEED_SQL);
  if (provider === 'sqlite') await execute(current, SQLITE_FTS_SQL);
  const currentBefore = await fingerprint(current);
  r = startup(current);
  expect(r.status !== 0 && /cannot be marked as applied without running/.test(r.output), 'must not skip search backfill/triggers on a db-push database');
  expect(await migrationRows(current) === null, 'non-DDL adoption must leave history untouched');
  // Documented operator path: the migration is idempotent, so run it as-is (installs the
  // triggers, backfills; the pushed table/indexes already exist), then explicitly confirm.
  const searchMigration = expected.find(name => name.endsWith('_article_search_table'));
  await execute(current, readFileSync(join('prisma/migrations', provider, searchMigration, 'migration.sql'), 'utf8'));
  expect(Number((await query(current, 'SELECT count(*) AS n FROM "ArticleSearch"'))[0].n) === 1, 'operator path did not backfill');
  r = startup(current, { FEEDFERRET_DB_ADOPT_CONFIRM: searchMigration });
  expect(r.status === 0 && /Legacy database matches the current schema: marking all/.test(r.output), `current-schema legacy exited ${r.status}`);
  expect(!/db push to the|Additive gap/.test(r.output), 'current-schema legacy must not push');
  expect(JSON.stringify(await migrationRows(current)) === JSON.stringify(expected), 'current-schema legacy: not all migrations marked applied');
  expect(/No pending migrations to apply/.test(r.output), 'current-schema legacy: migrations still pending');
  expect(currentBefore === await fingerprint(current), 'current-schema legacy changed data');

  // 6b. Interrupted search migration (killed container, crash): Prisma records it as failed
  //     (P3009) and refuses to start. After the documented `migrate resolve --rolled-back`
  //     the migration re-runs on top of whatever the interrupted run left behind (here the
  //     worst case: table + triggers installed, projection emptied) and completes.
  {
    const name = expected.find(n => n.endsWith('_article_search_table'));
    await execute(url, `DELETE FROM "ArticleSearch"; UPDATE _prisma_migrations SET finished_at = NULL, logs = 'simulated interruption' WHERE migration_name = '${name}'`);
    r = startup(url);
    expect(r.status !== 0 && /P3009|failed migrations/.test(r.output), 'a failed search migration must stop the start');
    run(['migrate', 'resolve', '--rolled-back', name], { DATABASE_URL: url, PRISMA_SCHEMA_OVERRIDE: schema, SHADOW_DATABASE_URL: '' });
    r = startup(url);
    expect(r.status === 0 && /Database schema matches prisma\/schema.prisma/.test(r.output), `re-run after --rolled-back exited ${r.status}`);
    expect(JSON.stringify(await migrationRows(url)) === JSON.stringify(expected), 're-run: wrong history');
    expect(Number((await query(url, 'SELECT count(*) AS n FROM "ArticleSearch"'))[0].n) ===
      Number((await query(url, 'SELECT count(*) AS n FROM "Article"'))[0].n), 're-run did not backfill the projection');
    const triggers = provider === 'sqlite'
      ? await query(url, "SELECT name FROM sqlite_master WHERE type = 'trigger' AND name IN ('article_search_ai', 'article_search_au')")
      : await query(url, "SELECT tgname FROM pg_trigger WHERE tgname IN ('article_search_ai', 'article_search_au')");
    expect(triggers.length === 2, `re-run: ${triggers.length} sync triggers`);
    expect(before === await fingerprint(url), 're-run changed application data');
  }

  if (provider === 'postgresql') {
    // 7a. Two instances starting at the same time on one legacy database: the advisory
    //     lock serializes adoption; both succeed, the history is recorded exactly once.
    const racy = await legacyDatabase('startup_concurrent', legacySchema);
    const racyBefore = await fingerprint(racy);
    const [one, two] = await Promise.all([startupAsync(racy), startupAsync(racy)]);
    expect(one.status === 0 && two.status === 0, `concurrent starts exited ${one.status}/${two.status}`);
    for (const out of [one.output, two.output]) expect(!/❌|Error:|P3008/.test(out), 'concurrent start logged an error');
    const states = [one.output, two.output].map((out) => out.match(/Database state: (\w+)/)[1]).sort();
    expect(JSON.stringify(states) === JSON.stringify(['legacy', 'migrated']), `concurrent states ${states}: the second start must see the adopted DB`);
    const rows = await query(racy, 'SELECT migration_name FROM _prisma_migrations');
    expect(rows.length === expected.length, `concurrent starts recorded ${rows.length} history rows`);
    expect(racyBefore === await fingerprint(racy), 'concurrent starts changed data');

    // 7b. Unreachable database: the pg_trgm check must fail the start, never silently
    //     continue without trigram indexes.
    const dead = new URL(await database('startup_unreachable'));
    dead.port = '1';
    r = startup(dead.toString(), { FEEDFERRET_DB_WAIT_ATTEMPTS: '1' });
    expect(r.status !== 0 && /Could not verify the pg_trgm extension/.test(r.output), 'unreachable DB must fail closed');
    expect(!/starting without trigram/.test(r.output), 'unreachable DB must not disable trgm');
  }

  // 8. Empty database: migrate deploy creates everything.
  const fresh = await database('startup_empty');
  r = startup(fresh);
  expect(r.status === 0 && /Database state: empty/.test(r.output) && /Database schema matches/.test(r.output), 'empty DB startup');
  expect(JSON.stringify(await migrationRows(fresh)) === JSON.stringify(expected), 'empty DB: wrong history');
  console.log(`${provider}: startup legacy-upgrade, idempotency, push fallback and fail-closed checks passed`);
}

const schema = join(dir, 'schema.prisma');
env.PRISMA_SCHEMA_OVERRIDE = schema;
const source = readFileSync('prisma/schema.prisma', 'utf8');
// scripts/db-migrate.sh (startup checks) rewrites the prepared schemas in prisma/ for this
// provider; restore them afterwards so local test runs keep their generated schema.
const preparedFiles = ['prisma/schema.generated.prisma', 'prisma/baseline.generated.prisma']
  .map((file) => [file, existsSync(file) ? readFileSync(file) : null]);
try {
  if (provider === 'postgresql') {
    if (!process.env.MIGRATION_TEST_ADMIN_URL) throw new Error('Set MIGRATION_TEST_ADMIN_URL to a disposable Postgres 16 server (CREATEDB/CREATEROLE required)');
    admin = new pg.Client({ connectionString: process.env.MIGRATION_TEST_ADMIN_URL });
    await admin.connect();
  }
  env.DATABASE_URL = await database('empty');
  env.SHADOW_DATABASE_URL = await database('shadow');
  writeFileSync(schema, prepareSchema(source, provider, { skipTrgm: env.PRISMA_PG_TRGM === '0' }));
  run(['validate']);
  try {
    run(['migrate', 'diff', '--from-migrations', `prisma/migrations/${provider}`, '--to-schema', schema, '--exit-code']);
  } catch (error) {
    if (error.status === 2) console.error('Migration drift: run pnpm db:migration:new <name> for both providers');
    throw error;
  }
  run(['migrate', 'deploy']);
  run(['migrate', 'diff', '--from-config-datasource', '--to-schema', schema, '--exit-code']);

  env.DATABASE_URL = await database('legacy');
  if (provider === 'postgresql') await execute(env.DATABASE_URL, 'CREATE EXTENSION pg_trgm');
  // Freeze the old db-push shape so this remains a valid upgrade test after
  // future migrations are appended. At groundwork this equals current schema.
  const legacySchema = join(dir, 'baseline.prisma');
  writeFileSync(legacySchema, prepareSchema(readFileSync('prisma/baseline.schema.prisma', 'utf8'), provider));
  env.PRISMA_SCHEMA_OVERRIDE = legacySchema;
  run(['db', 'push']);
  await execute(env.DATABASE_URL, `INSERT INTO "User" (id, email, "updatedAt") VALUES ('m11-preserve', 'm11@example.test', CURRENT_TIMESTAMP)`);
  if (provider === 'sqlite') {
    await execute(env.DATABASE_URL, `CREATE VIRTUAL TABLE article_fts USING fts5(title, tokenize='trigram');
      INSERT INTO article_fts(title) VALUES ('preserve this search row');
      CREATE TABLE article_fts_meta (id INTEGER PRIMARY KEY, backfilled_at TEXT);
      INSERT INTO article_fts_meta VALUES (1, 'preserve');`);
  }
  const snapshot = async () => JSON.stringify({
    users: await query(env.DATABASE_URL, 'SELECT id, email, "updatedAt" FROM "User" ORDER BY id'),
    ...(provider === 'sqlite' ? {
      objects: await query(env.DATABASE_URL, "SELECT name, rootpage, sql FROM sqlite_master WHERE name LIKE 'article_fts%' ORDER BY name"),
      fts: await query(env.DATABASE_URL, 'SELECT * FROM article_fts'),
      meta: await query(env.DATABASE_URL, 'SELECT * FROM article_fts_meta'),
    } : {}),
  });
  const before = await snapshot();
  // Reproduce PR 3's prerequisite only: prove legacy schema matches, then mark
  // baseline applied. No startup wrapper or production cut-over in this PR.
  run(['migrate', 'diff', '--from-config-datasource', '--to-schema', legacySchema, '--exit-code']);
  run(['migrate', 'resolve', '--applied', baseline]);
  env.PRISMA_SCHEMA_OVERRIDE = schema;
  run(['migrate', 'deploy']);
  run(['migrate', 'status']);
  if (before !== await snapshot()) throw new Error('Legacy baseline changed application data or FTS objects');
  const applied = await query(env.DATABASE_URL, 'SELECT migration_name FROM _prisma_migrations WHERE finished_at IS NOT NULL');
  if (JSON.stringify(applied.map((row) => row.migration_name).sort()) !== JSON.stringify(migrationNames('prisma/migrations', provider))) throw new Error('Unexpected legacy migration history');
  run(['migrate', 'diff', '--from-config-datasource', '--to-schema', schema, '--exit-code']);

  await startupUpgradeChecks(legacySchema);

  if (provider === 'postgresql') {
    // A role that owns the schema but cannot install trusted extensions: database
    // CREATE is revoked even from its owner, while public schema CREATE remains.
    role = `${prefix}_role`;
    await admin.query(`CREATE ROLE "${role}" LOGIN PASSWORD 'm11-test-only'`);
    env.DATABASE_URL = await database('restricted', role);
    const privileged = new URL(env.DATABASE_URL);
    const adminUrl = new URL(process.env.MIGRATION_TEST_ADMIN_URL);
    privileged.username = adminUrl.username; privileged.password = adminUrl.password;
    await execute(privileged.toString(), `REVOKE CREATE ON DATABASE "${prefix}_restricted" FROM PUBLIC, "${role}"`);
    run(['migrate', 'deploy']);
    const ext = await query(env.DATABASE_URL, "SELECT extname FROM pg_extension WHERE extname='pg_trgm'");
    const idx = await query(env.DATABASE_URL, "SELECT indexname FROM pg_indexes WHERE indexname LIKE 'ArticleSearch_%_trgm_idx'");
    if (ext.length || idx.length) throw new Error('Restricted test did not exercise missing pg_trgm');
    env.PRISMA_PG_TRGM = '0';
    writeFileSync(schema, prepareSchema(source, provider, { skipTrgm: env.PRISMA_PG_TRGM === '0' }));
    run(['migrate', 'diff', '--from-config-datasource', '--to-schema', schema, '--exit-code']);
    run(['migrate', 'status']);
    // Startup on the restricted role detects the missing extension itself.
    let r = startup(env.DATABASE_URL, { PRISMA_PG_TRGM: '' });
    expect(r.status === 0 && /starting without trigram search indexes/.test(r.output), 'restricted startup');
    expect(/No pending migrations to apply/.test(r.output) && /Database schema matches/.test(r.output), 'restricted startup drift');

    // Extension installed by an admin, role without CREATE: trgm stays enabled.
    const withExt = await database('restricted_ext', role);
    privileged.pathname = new URL(withExt).pathname;
    await execute(privileged.toString(), `CREATE EXTENSION pg_trgm; REVOKE CREATE ON DATABASE "${prefix}_restricted_ext" FROM PUBLIC, "${role}"`);
    r = startup(withExt, { PRISMA_PG_TRGM: '' });
    expect(r.status === 0 && /pg_trgm extension available/.test(r.output) && !/starting without trigram/.test(r.output), 'pre-installed pg_trgm must be used');
    const trgmIdx = await query(withExt, "SELECT indexname FROM pg_indexes WHERE indexname LIKE 'ArticleSearch_%_trgm_idx'");
    expect(trgmIdx.length === 5 && /Database schema matches/.test(r.output), `pre-installed pg_trgm: ${trgmIdx.length} trigram indexes`);

    // Legacy db-push database of a restricted install (pushed without trgm indexes),
    // with the production-style `?schema=public` URL.
    const legacyUrl = new URL(await database('restricted_legacy', role));
    privileged.pathname = legacyUrl.pathname;
    await execute(privileged.toString(), `REVOKE CREATE ON DATABASE "${prefix}_restricted_legacy" FROM PUBLIC, "${role}"`);
    legacyUrl.searchParams.set('schema', 'public');
    const legacyNoTrgm = join(dir, 'baseline-notrgm.prisma');
    writeFileSync(legacyNoTrgm, prepareSchema(readFileSync('prisma/baseline.schema.prisma', 'utf8'), provider, { skipTrgm: true }));
    run(['db', 'push'], { DATABASE_URL: legacyUrl.toString(), PRISMA_SCHEMA_OVERRIDE: legacyNoTrgm, SHADOW_DATABASE_URL: '' });
    await execute(legacyUrl.toString(), SEED_SQL);
    const before = await fingerprint(legacyUrl.toString());
    r = startup(legacyUrl.toString(), { PRISMA_PG_TRGM: '' });
    expect(r.status === 0 && /Legacy database matches the (current schema|baseline)/.test(r.output), 'restricted legacy upgrade');
    expect(JSON.stringify(await migrationRows(legacyUrl.toString())) === JSON.stringify(migrationNames('prisma/migrations', provider)), 'restricted legacy history');
    expect(before === await fingerprint(legacyUrl.toString()), 'restricted legacy data changed');
  }
  console.log(`${provider}: drift, apply-from-empty, legacy preservation, startup and privilege checks passed`);
} finally {
  for (const [file, content] of preparedFiles) {
    if (content === null) rmSync(file, { force: true }); else writeFileSync(file, content);
  }
  if (admin) {
    for (const name of databases.reverse()) await admin.query(`DROP DATABASE "${name}" WITH (FORCE)`);
    if (role) await admin.query(`DROP ROLE "${role}"`);
    await admin.end();
  }
  rmSync(dir, { recursive: true, force: true });
}
