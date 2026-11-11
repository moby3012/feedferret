import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { prepareSchema } from './prepare-prisma-schema.mjs';
import { providers, prisma, guardTrgm, assertParity } from './migration-utils.mjs';
const name = process.argv[2];
if (!name || !/^[a-z][a-z0-9_]*$/.test(name)) throw new Error('Usage: pnpm db:migration:new <snake_case_name>');
assertParity();
const old = execFileSync('git', ['show', 'origin/main:prisma/schema.prisma'], { encoding: 'utf8' });
const current = readFileSync('prisma/schema.prisma', 'utf8');
const dir = mkdtempSync(join(tmpdir(), 'ff-migration-'));
const id = `${new Date().toISOString().replace(/\D/g, '').slice(0, 14)}_${name}`;
try {
  // Generate both before writing either directory, so a failure cannot leave half a pair.
  const results = providers.map((provider) => {
    const from = join(dir, `${provider}-old.prisma`), to = join(dir, `${provider}-new.prisma`);
    writeFileSync(from, prepareSchema(old, provider));
    writeFileSync(to, prepareSchema(current, provider));
    const sql = prisma(['migrate', 'diff', '--from-schema', from, '--to-schema', to, '--script'], { ...process.env, DATABASE_PROVIDER: provider });
    return [provider, provider === 'postgresql' ? guardTrgm(sql) : sql];
  });
  for (const [provider, sql] of results) {
    const target = `prisma/migrations/${provider}/${id}`;
    mkdirSync(target);
    writeFileSync(`${target}/migration.sql`, sql);
  }
  console.log(`Created ${id} for both providers. Review SQL and run pnpm db:migrations:check.`);
} finally { rmSync(dir, { recursive: true, force: true }); }
