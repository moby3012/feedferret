import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const aliases = new Map([
  ['sqlite', 'sqlite'],
  ['file', 'sqlite'],
  ['postgres', 'postgresql'],
  ['postgresql', 'postgresql'],
]);

/**
 * Turns prisma/schema.prisma into the schema for one provider.
 *
 * Provider-only schema lines are written as `//@postgresql <attribute>` (or `//@sqlite`)
 * comments in schema.prisma, e.g. the pg_trgm GIN search indexes, and enabled here for that
 * provider. `skipTrgm` leaves the trigram indexes out: scripts/db-sync.sh sets
 * PRISMA_PG_TRGM=0 when the pg_trgm extension cannot be created, so `db push` does not
 * fail on the unknown `gin_trgm_ops` operator class.
 */
export function prepareSchema(source, provider, { skipTrgm = false } = {}) {
  const withProvider = source.replace(/provider\s*=\s*"(?:sqlite|postgresql)"/, `provider = "${provider}"`);
  return withProvider.replace(/^([ \t]*)\/\/@(sqlite|postgresql) (.*)$/gm, (line, indent, only, rest) => {
    if (only !== provider) return line;
    if (skipTrgm && rest.includes('gin_trgm_ops')) return line;
    return `${indent}${rest}`;
  });
}

function main() {
  const requested = (process.env.DATABASE_PROVIDER || 'sqlite').toLowerCase();
  const provider = aliases.get(requested);
  if (!provider) {
    console.error(`Unsupported DATABASE_PROVIDER="${requested}". Use sqlite or postgresql.`);
    process.exit(1);
  }

  // `--source`/`--target` let scripts/db-migrate.sh prepare the frozen baseline
  // (prisma/baseline.schema.prisma) the same way as the live schema.
  const arg = (name, fallback) => {
    const i = process.argv.indexOf(name);
    return i > 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
  };
  const sourcePath = arg('--source', path.join('prisma', 'schema.prisma'));
  const targetPath = arg('--target', path.join('prisma', 'schema.generated.prisma'));
  const skipTrgm = provider === 'postgresql' && process.env.PRISMA_PG_TRGM === '0';
  fs.writeFileSync(targetPath, prepareSchema(fs.readFileSync(sourcePath, 'utf8'), provider, { skipTrgm }));
  console.log(`Prepared Prisma schema for ${provider}: ${targetPath}${skipTrgm ? ' (without pg_trgm indexes)' : ''}`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main();
}
