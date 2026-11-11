// Integration gate. SQLite uses temporary files; Postgres creates/drops uniquely
// named databases via MIGRATION_TEST_ADMIN_URL. Never point this at production.
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
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
const schema = join(dir, 'schema.prisma');
env.PRISMA_SCHEMA_OVERRIDE = schema;
const source = readFileSync('prisma/schema.prisma', 'utf8');
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
    const idx = await query(env.DATABASE_URL, "SELECT indexname FROM pg_indexes WHERE indexname LIKE 'Article_%_trgm_idx'");
    if (ext.length || idx.length) throw new Error('Restricted test did not exercise missing pg_trgm');
    env.PRISMA_PG_TRGM = '0';
    writeFileSync(schema, prepareSchema(source, provider, { skipTrgm: env.PRISMA_PG_TRGM === '0' }));
    run(['migrate', 'diff', '--from-config-datasource', '--to-schema', schema, '--exit-code']);
    run(['migrate', 'status']);
  }
  console.log(`${provider}: drift, apply-from-empty, legacy preservation and privilege checks passed`);
} finally {
  if (admin) {
    for (const name of databases.reverse()) await admin.query(`DROP DATABASE "${name}" WITH (FORCE)`);
    if (role) await admin.query(`DROP ROLE "${role}"`);
    await admin.end();
  }
  rmSync(dir, { recursive: true, force: true });
}
