import fs from 'node:fs';
import path from 'node:path';

const aliases = new Map([
  ['sqlite', 'sqlite'],
  ['file', 'sqlite'],
  ['postgres', 'postgresql'],
  ['postgresql', 'postgresql'],
]);

const requested = (process.env.DATABASE_PROVIDER || 'sqlite').toLowerCase();
const provider = aliases.get(requested);
if (!provider) {
  console.error(`Unsupported DATABASE_PROVIDER="${requested}". Use sqlite or postgresql.`);
  process.exit(1);
}

const sourcePath = path.join('prisma', 'schema.prisma');
const targetPath = path.join('prisma', 'schema.generated.prisma');
const source = fs.readFileSync(sourcePath, 'utf8');
const generated = source.replace(/provider\s*=\s*"(?:sqlite|postgresql)"/, `provider = "${provider}"`);

fs.writeFileSync(targetPath, generated);
console.log(`Prepared Prisma schema for ${provider}: ${targetPath}`);
