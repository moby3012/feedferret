// Deploy rehearsal for the ArticleSearch migration (synthetic data only). Never point this at production.
//
//   PERF_BENCH_ADMIN_URL=postgresql://postgres:pw@127.0.0.1:5432/postgres \
//     DATABASE_PROVIDER=postgresql node scripts/bench-search-migration.mjs \
//     [--articles 200000] [--writers 2] [--trials 3] [--words 450] [--json out.json] [--keep]
//
// Creates ONE scratch database (ff_searchmig_bench), applies the history up to the migration
// before 20261112170000_article_search_table, seeds synthetic articles and the legacy Article GIN
// indexes, then:
//   1. trials: `prisma migrate deploy` of the search migration while N writers insert/update/
//      bulk mark-read (SELECT … FOR UPDATE + UPDATE)/delete articles in multi-statement transactions; asserts no deadlock, no
//      deferred backfill, complete projection, Article indexes untouched.
//   2. background index swap: the real lib/search-indexes.ts helper (bundled with esbuild) while
//      the writers keep running; asserts 5 valid ArticleSearch indexes, 0 legacy ones.
//   3. kill tests: SIGKILL + backend termination in the middle of the migration copy and in
//      the middle of a CREATE INDEX CONCURRENTLY; a plain restart must recover (no operator step).
// Drops the database at the end unless --keep. Needs pg_trgm. Disk: ~5x the Article size.
import { execFileSync, spawn } from 'node:child_process';
import { cpSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, join, resolve } from 'node:path';
import pg from 'pg';

const arg = (name, fallback) => {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 ? process.argv[i + 1] : fallback;
};
const ARTICLES = Number(arg('articles', '200000'));
const WRITERS = Number(arg('writers', '2'));
const TRIALS = Number(arg('trials', '3'));
const WORDS = Number(arg('words', '450'));
const KEEP = process.argv.includes('--keep');
const ONLY_KILL = process.argv.includes('--only-kill');
const admin = process.env.PERF_BENCH_ADMIN_URL;
if (!admin) throw new Error('Set PERF_BENCH_ADMIN_URL to a disposable Postgres server');
if ((process.env.DATABASE_PROVIDER || '').toLowerCase() !== 'postgresql') throw new Error('Run with DATABASE_PROVIDER=postgresql (and a Postgres-generated Prisma client)');

const NAME = 'ff_searchmig_bench';
const url = new URL(admin); url.pathname = `/${NAME}`;
const DB_URL = url.toString();
const ROOT = 'prisma/migrations/postgresql';
const SEARCH = readdirSync(ROOT).find((n) => n.endsWith('_article_search_table'));
const dir = mkdtempSync(join(tmpdir(), 'ff-searchmig-'));
const results = { articles: ARTICLES, writers: WRITERS, trials: [], indexBuild: null, kills: [] };
const log = (...a) => console.log(`[${new Date().toISOString().slice(11, 19)}]`, ...a);
const sec = (ms) => Math.round(ms / 100) / 10;

async function q(sql, params, target = DB_URL) {
  const c = new pg.Client({ connectionString: target });
  await c.connect();
  try { return (await c.query(sql, params)).rows; } finally { await c.end(); }
}
function config(includeSearch) {
  const migrations = join(dir, includeSearch ? 'full' : 'pre');
  rmSync(migrations, { recursive: true, force: true });
  mkdirSync(migrations);
  for (const name of readdirSync(ROOT)) {
    if (!includeSearch && name === SEARCH) continue;
    cpSync(join(ROOT, name), join(migrations, name), { recursive: true });
  }
  const file = join(dir, `${includeSearch ? 'full' : 'pre'}.config.mjs`);
  writeFileSync(file, `export default ${JSON.stringify({ schema: resolve('prisma/schema.generated.prisma'), migrations: { path: migrations }, datasource: { url: DB_URL } })}`);
  return file;
}
const prismaBin = resolve('node_modules/.bin/prisma');

async function seed() {
  log(`seeding ${ARTICLES} articles (~${WORDS} words each)`);
  await q(`DROP DATABASE IF EXISTS "${NAME}" WITH (FORCE)`, [], admin);
  await q(`CREATE DATABASE "${NAME}"`, [], admin);
  await q('CREATE EXTENSION IF NOT EXISTS pg_trgm');
  execFileSync(prismaBin, ['migrate', 'deploy', '--config', config(false)], { stdio: 'pipe' });
  // Build the legacy indexes after the bulk load (much faster), exactly as the baseline defines them.
  for (const c of ['title', 'content', 'excerpt', 'author', 'entities']) await q(`DROP INDEX IF EXISTS "Article_${c}_trgm_idx"`);
  await q(`INSERT INTO "User" (id, email, "updatedAt") VALUES ('bench-user', 'bench@example.test', now())`);
  await q(`INSERT INTO "Feed" (id, url, name, "userId", "updatedAt")
           SELECT 'bench-feed-' || f, 'https://example.test/feed/' || f, 'Feed ' || f, 'bench-user', now() FROM generate_series(0, 199) f`);
  await q(`CREATE TABLE bench_words AS SELECT k, substr(md5(k::text), 1, 3 + k % 8) AS w FROM generate_series(0, 999) k`);
  const chunk = 10000;
  for (let from = 0; from < ARTICLES; from += chunk) {
    await q(`INSERT INTO "Article" (id, "feedId", "userId", title, link, content, excerpt, author, entities, "publishedAt", "updatedAt")
      SELECT 'bench-' || i, 'bench-feed-' || (i % 200), 'bench-user',
             'Headline ' || i || ' ' || (SELECT w FROM bench_words WHERE k = i % 1000),
             'https://example.test/a/' || i,
             (SELECT string_agg(w, ' ') FROM generate_series(1, $3::int) j JOIN bench_words ON k = (i * 7919 + j * 104729 + j * j) % 1000),
             'Excerpt ' || i, CASE WHEN i % 3 = 0 THEN 'Author ' || (i % 97) END,
             CASE WHEN i % 4 = 0 THEN '["Entity ' || (i % 50) || '"]' END,
             now() - (i || ' minutes')::interval, now()
      FROM generate_series($1::int, $2::int) i`, [from, Math.min(from + chunk, ARTICLES) - 1, WORDS]);
  }
  await q('DROP TABLE bench_words');
  let t = Date.now();
  for (const c of ['title', 'content', 'excerpt', 'author', 'entities']) {
    await q(`CREATE INDEX "Article_${c}_trgm_idx" ON "Article" USING GIN ("${c}" gin_trgm_ops)`);
  }
  results.legacyIndexBuildSeconds = sec(Date.now() - t); // what an older image's startup costs after a rollback
  await q('VACUUM ANALYZE "Article"');
  const [size] = await q(`SELECT pg_size_pretty(pg_total_relation_size('"Article"')) AS total,
    pg_size_pretty(pg_relation_size('"Article"') + coalesce(pg_total_relation_size(reltoastrelid), 0)) AS heap_toast
    FROM pg_class WHERE relname = 'Article'`);
  results.articleSize = size;
  log('seeded', size, `legacy GIN build ${results.legacyIndexBuildSeconds}s`);
}

/** Writers with the access pattern that deadlocked the old migration: Article writes whose trigger touches ArticleSearch. */
function startWriters() {
  const state = { stop: false, ops: 0, errors: {} };
  let seq = 0;
  const run = Date.now().toString(36);
  const workers = Array.from({ length: WRITERS }, async (_, w) => {
    const c = new pg.Client({ connectionString: DB_URL });
    await c.connect();
    while (!state.stop) {
      const pick = () => `bench-${Math.floor(Math.random() * ARTICLES)}`;
      try {
        await c.query('BEGIN');
        await c.query(`INSERT INTO "Article" (id, "feedId", "userId", title, link, content, "publishedAt", "updatedAt")
          VALUES ($1, 'bench-feed-1', 'bench-user', 'live title', $2, 'live body text', now(), now())`, [`live-${run}-${w}-${seq}`, `https://example.test/live/${run}/${w}/${seq++}`]);
        await c.query(`UPDATE "Article" SET title = title || ' (upd)' WHERE id = $1`, [pick()]);
        // Bulk mark-read as in server/articles/bulk-read.ts: row-lock the batch, then update it.
        const batch = Array.from({ length: 50 }, pick);
        await c.query(`SELECT id FROM "Article" WHERE id = ANY($1) ORDER BY id FOR UPDATE`, [batch]);
        await c.query(`UPDATE "Article" SET "isRead" = true, "readAt" = now() WHERE id = ANY($1)`, [batch]);
        if (Math.random() < 0.2) await c.query(`DELETE FROM "Article" WHERE id = $1`, [pick()]);
        await c.query('COMMIT');
        state.ops++;
      } catch (err) {
        await c.query('ROLLBACK').catch(() => {});
        state.errors[err.code || err.message] = (state.errors[err.code || err.message] || 0) + 1;
      }
    }
    await c.end();
  });
  return { state, done: () => { state.stop = true; return Promise.all(workers); } };
}

async function resetSearch() {
  await q('DROP TABLE IF EXISTS "ArticleSearch" CASCADE');
  await q('DROP FUNCTION IF EXISTS article_search_sync() CASCADE');
  await q('DELETE FROM _prisma_migrations WHERE migration_name = $1', [SEARCH]);
}
async function verifyProjection(label) {
  const [c] = await q(`SELECT (SELECT count(*) FROM "Article")::int AS a, (SELECT count(*) FROM "ArticleSearch")::int AS s,
    (SELECT count(*) FROM pg_trigger WHERE tgname IN ('article_search_ai', 'article_search_au'))::int AS triggers,
    (SELECT count(*) FROM pg_indexes WHERE indexname LIKE 'Article\\_%\\_trgm\\_idx')::int AS legacy,
    (SELECT count(*) FROM pg_indexes WHERE indexname LIKE 'ArticleSearch\\_%\\_trgm\\_idx')::int AS search`);
  // Sampled content check: projection rows equal their article.
  const [drift] = await q(`SELECT count(*)::int AS n FROM "Article" a JOIN "ArticleSearch" s USING (id)
    WHERE (a.title, a.content, a.excerpt, a.author, a.entities) IS DISTINCT FROM (s.title, s.content, s.excerpt, s.author, s.entities)`);
  log(label, { ...c, contentMismatches: drift.n });
  return { ...c, contentMismatches: drift.n };
}
function migrate(extraEnv = {}) {
  return spawn(prismaBin, ['migrate', 'deploy', '--config', config(true)], { env: { ...process.env, ...extraEnv } });
}
function collect(child) {
  return new Promise((done) => {
    let out = '';
    child.stdout.on('data', (d) => { out += d; });
    child.stderr.on('data', (d) => { out += d; });
    child.on('close', (status, signal) => done({ status, signal, out }));
  });
}

async function trial(n) {
  await resetSearch();
  const writers = startWriters();
  await new Promise((r) => setTimeout(r, 1500));
  const t = Date.now();
  const res = await collect(migrate());
  const seconds = sec(Date.now() - t);
  await new Promise((r) => setTimeout(r, 1000));
  await writers.done();
  const v = await verifyProjection(`trial ${n}`);
  const deadlock = /deadlock/i.test(res.out);
  const deferred = /backfill deferred/i.test(res.out);
  const ok = res.status === 0 && !deadlock && !deferred && v.a === v.s && v.triggers === 2 && v.legacy === 5 && v.search === 0 && v.contentMismatches === 0;
  results.trials.push({ trial: n, ok, migrateSeconds: seconds, exit: res.status, deadlock, deferred, writerOps: writers.state.ops, writerErrors: writers.state.errors, ...v });
  log(`trial ${n}: ${ok ? 'OK' : 'FAILED'} in ${seconds}s, writer ops ${writers.state.ops}, writer errors`, writers.state.errors);
  if (!ok) console.log(res.out);
}

function bundleHelper() {
  const out = resolve('node_modules/.cache/ff-bench/search-indexes.mjs');
  execFileSync(resolve('node_modules/.bin/esbuild'), ['lib/search-indexes.ts', '--bundle', '--platform=node', '--format=esm', '--packages=external', `--outfile=${out}`], { stdio: 'pipe' });
  return out;
}
function runHelper(bundle) {
  const code = `const m = await import(${JSON.stringify(bundle)}); await m.ensureSearchIndexes({ postgresUrl: process.env.DATABASE_URL }); console.log('STATUS', JSON.stringify(m.postgresSearchIndexStatus())); process.exit(0);`;
  return spawn(process.execPath, ['--input-type=module', '-e', code], { env: { ...process.env, DATABASE_URL: DB_URL, DATABASE_PROVIDER: 'postgresql' } });
}

async function indexBuild(bundle) {
  const writers = startWriters();
  const t = Date.now();
  const res = await collect(runHelper(bundle));
  const seconds = sec(Date.now() - t);
  await writers.done();
  const v = await verifyProjection('background indexes');
  const invalid = await q(`SELECT count(*)::int AS n FROM pg_index WHERE NOT indisvalid`);
  const ok = res.status === 0 && /"state":"ready"/.test(res.out) && v.search === 5 && v.legacy === 0 && invalid[0].n === 0 && v.a === v.s;
  const perIndex = [...res.out.matchAll(/(ArticleSearch_\w+_trgm_idx) built in ([\d.]+) s/g)].map((m) => ({ index: m[1], seconds: Number(m[2]) }));
  const [sizes] = await q(`SELECT pg_size_pretty(pg_total_relation_size('"ArticleSearch"')) AS projection_total, pg_size_pretty(pg_indexes_size('"ArticleSearch"')) AS projection_indexes`);
  results.indexBuild = { ok, seconds, perIndex, writerOps: writers.state.ops, writerErrors: writers.state.errors, ...sizes, ...v };
  log(`background index build: ${ok ? 'OK' : 'FAILED'} in ${seconds}s`, perIndex, sizes, 'writer errors', writers.state.errors);
  if (!ok) console.log(res.out);
}

async function waitFor(sqlPredicate, timeoutMs = 120000) {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    const rows = await q(`SELECT pid FROM pg_stat_activity WHERE datname = $1 AND state = 'active' AND ${sqlPredicate}`, [NAME]);
    if (rows.length) return rows.map((r) => r.pid);
    await new Promise((r) => setTimeout(r, 50));
  }
  return [];
}
async function startup() {
  const child = spawn('sh', ['scripts/db-migrate.sh'], { env: { ...process.env, DATABASE_URL: DB_URL, DATABASE_PROVIDER: 'postgresql', PATH: `${resolve('node_modules/.bin')}${delimiter}${process.env.PATH}` } });
  const result = collect(child);
  let running = true;
  void result.then(() => { running = false; });
  const blockers = [];
  while (running) {
    await new Promise((r) => setTimeout(r, 1000));
    const rows = await q(`SELECT w.pid, w.wait_event_type, left(w.query, 50) AS waiting, b.pid AS blocker, b.state AS blocker_state, left(b.query, 80) AS blocker_query, b.backend_type
      FROM pg_stat_activity w JOIN LATERAL unnest(pg_blocking_pids(w.pid)) bp(pid) ON true JOIN pg_stat_activity b ON b.pid = bp.pid
      WHERE w.datname = $1 AND w.query ILIKE '%ArticleSearch%'`, [NAME]).catch(() => []);
    if (rows.length) blockers.push(...rows);
  }
  const r = await result;
  if (blockers.length) log('migration was blocked by', blockers.slice(0, 5));
  return { status: r.status, out: r.out, blockers };
}

async function killMigration() {
  await resetSearch();
  const writers = startWriters();
  const child = migrate();
  const output = collect(child);
  // The copy phase: the migration backend holds the EXCLUSIVE lock on Article.
  const pids = await waitFor(`pid IN (SELECT pid FROM pg_locks WHERE relation = '"Article"'::regclass AND mode = 'ExclusiveLock' AND granted)`);
  child.kill('SIGKILL'); // the container dies...
  for (const pid of pids) await q('SELECT pg_terminate_backend($1)', [pid], admin); // ...and its connection with it
  await output;
  // Restart: startup sees the interrupted (P3009) idempotent migration, marks it rolled back
  // and runs it again (scripts/db-migrate.mjs), no operator step.
  const restart = await startup();
  const autoResolved = /was interrupted \(P3009\)/.test(restart.out);
  await writers.done();
  const v = await verifyProjection('after kill + restart');
  const ok = pids.length > 0 && autoResolved && restart.status === 0 && v.a === v.s && v.triggers === 2;
  results.kills.push({ phase: 'migration copy', ok, killedBackends: pids.length, autoResolvedOnRestart: autoResolved, restartExit: restart.status, writerErrors: writers.state.errors, ...v });
  log(`kill during migration: ${ok ? 'OK' : 'FAILED'}`);
  if (!ok) console.log(restart.out, restart.blockers);
}

async function killIndexBuild(bundle) {
  await q('DROP INDEX IF EXISTS "ArticleSearch_content_trgm_idx"');
  const child = runHelper(bundle);
  const output = collect(child);
  const pids = await waitFor(`query ILIKE 'CREATE INDEX CONCURRENTLY%ArticleSearch_content_trgm_idx%'`);
  await new Promise((r) => setTimeout(r, 500));
  child.kill('SIGKILL');
  for (const pid of pids) await q('SELECT pg_terminate_backend($1)', [pid], admin);
  await output;
  const [left] = await q(`SELECT count(*)::int AS n FROM pg_index WHERE indexrelid = to_regclass('"ArticleSearch_content_trgm_idx"') AND NOT indisvalid`);
  const res = await collect(runHelper(bundle));
  const v = await verifyProjection('after killed CONCURRENTLY build + restart');
  const [invalid] = await q('SELECT count(*)::int AS n FROM pg_index WHERE NOT indisvalid');
  const ok = pids.length > 0 && left.n === 1 && /INVALID/.test(res.out) && /"state":"ready"/.test(res.out) && invalid.n === 0 && v.search === 5;
  results.kills.push({ phase: 'CREATE INDEX CONCURRENTLY', ok, invalidLeftover: left.n, rebuiltOnRestart: /INVALID/.test(res.out), ...v });
  log(`kill during concurrent index build: ${ok ? 'OK' : 'FAILED'}`);
  if (!ok) console.log(res.out);
}

try {
  await seed();
  if (!ONLY_KILL) {
    for (let i = 1; i <= TRIALS; i++) await trial(i);
    const bundle = bundleHelper();
    await indexBuild(bundle);
    await killIndexBuild(bundle);
  }
  // Kill test last: the reset drops the projection (and with it its indexes), legacy indexes are gone by now.
  await killMigration();
} finally {
  if (!KEEP) await q(`DROP DATABASE IF EXISTS "${NAME}" WITH (FORCE)`, [], admin).catch(() => {});
  rmSync(dir, { recursive: true, force: true });
  const out = arg('json');
  if (out) writeFileSync(out, `${JSON.stringify(results, null, 2)}\n`);
  console.log(JSON.stringify(results, null, 2));
}
