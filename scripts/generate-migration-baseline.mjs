// Reproduce the frozen baseline; never overwrite it with a later working schema.
import { readFileSync, writeFileSync } from 'node:fs';
import { prepareSchema } from './prepare-prisma-schema.mjs';
import { providers, baseline, prisma, guardTrgm } from './migration-utils.mjs';
const source = readFileSync('prisma/baseline.schema.prisma', 'utf8');
for (const provider of providers) {
  writeFileSync('prisma/schema.generated.prisma', prepareSchema(source, provider));
  const sql = prisma(['migrate', 'diff', '--from-empty', '--to-schema', 'prisma/schema.generated.prisma', '--script'], { ...process.env, DATABASE_PROVIDER: provider });
  writeFileSync(`prisma/migrations/${provider}/${baseline}/migration.sql`, provider === 'postgresql' ? guardTrgm(sql) : sql);
}
