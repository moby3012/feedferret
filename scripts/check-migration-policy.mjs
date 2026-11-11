import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { assertParity, assertSafeSql, migrationNames, providers } from './migration-utils.mjs';
assertParity();
// Scan all history: an approval marker documents every destructive exception.
for (const provider of providers) {
  for (const name of migrationNames('prisma/migrations', provider)) {
    const file = `prisma/migrations/${provider}/${name}/migration.sql`;
    assertSafeSql(readFileSync(file, 'utf8'), file);
  }
}
// Applied migrations (including the frozen baseline) must never be edited/deleted.
const base = process.env.MIGRATION_BASE_REF || 'origin/main';
const changed = execFileSync('git', ['diff', '--name-status', '--no-renames', base, '--', 'prisma/migrations', 'prisma/baseline.schema.prisma'], { encoding: 'utf8' });
if (changed.split('\n').some((line) => /^[MD]\tprisma\/(?:migrations\/(?:sqlite|postgresql)\/|baseline\.schema\.prisma)/.test(line))) {
  throw new Error('Existing migration history/baseline is immutable; append a new migration');
}
console.log('Migration parity, SQL policy and history checks passed');
