import { execFileSync } from 'node:child_process';
import { readdirSync } from 'node:fs';

export const providers = ['sqlite', 'postgresql'];
export const baseline = '00000000000000_init';
export function prisma(args, env = process.env) {
  return execFileSync('pnpm', ['exec', 'prisma', ...args], { env, encoding: 'utf8', stdio: ['pipe', 'pipe', 'inherit'] });
}

// pg_trgm is optional on managed/restricted installations. Keep extension creation
// and all dependent indexes guarded, including migrations generated after baseline.
export function guardTrgm(sql) {
  // PostgreSQL checks database CREATE even for CREATE SCHEMA IF NOT EXISTS
  // when public already exists. A restricted schema owner must still migrate.
  sql = sql.replace('CREATE SCHEMA IF NOT EXISTS "public";', () => `DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_namespace WHERE nspname = 'public') THEN
    CREATE SCHEMA "public";
  END IF;
END $$;`);
  const indexes = [];
  sql = sql.replace(/CREATE (?:UNIQUE )?INDEX[^;]*gin_trgm_ops[^;]*;/g, (statement) => {
    indexes.push(statement.replace('CREATE INDEX ', 'CREATE INDEX IF NOT EXISTS '));
    return '';
  });
  if (!indexes.length) return sql;
  return `DO $$ BEGIN
  CREATE EXTENSION IF NOT EXISTS pg_trgm;
EXCEPTION WHEN insufficient_privilege OR undefined_file OR feature_not_supported THEN
  RAISE NOTICE 'pg_trgm unavailable';
END $$;
\n${sql}\nDO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'pg_trgm') THEN
    ${indexes.join('\n    ')}
  END IF;
END $$;
`;
}

export function migrationNames(root, provider) {
  return readdirSync(`${root}/${provider}`, { withFileTypes: true })
    .filter((entry) => entry.isDirectory()).map((entry) => entry.name).sort();
}
export function assertParity(root = 'prisma/migrations') {
  if (JSON.stringify(migrationNames(root, 'sqlite')) !== JSON.stringify(migrationNames(root, 'postgresql'))) {
    throw new Error('Migration provider parity failed: add the same migration name for both providers');
  }
}

export function assertSafeSql(sql, file) {
  // Strip comments before scanning SQL; keep Prisma's RedefineTables sentinel.
  const code = sql.replace(/\/\*[\s\S]*?\*\//g, '').replace(/--[^\n]*/g, '');
  const destructive = /\bDROP\s+(?:TABLE|COLUMN|INDEX|SCHEMA|TYPE|VIEW|TRIGGER|EXTENSION|CONSTRAINT|SEQUENCE|FUNCTION)\b|\bALTER\s+TABLE\b[^;]*\bDROP\b|\bALTER\s+(?:COLUMN\s+)?[^;]*\bTYPE\b/i.test(code)
    || /RedefineTables/.test(sql);
  if (destructive && !/^[ \t]*-- ff:allow-destructive[ \t]+\S[^\n]*$/m.test(sql)) {
    throw new Error(`${file}: destructive SQL needs -- ff:allow-destructive <reason>`);
  }
  // Every trigram index must be inside an extension-existence DO block.
  const withoutGuards = code.replace(/DO\s+\$\$\s*BEGIN\s+IF EXISTS\s*\(SELECT 1 FROM pg_extension WHERE extname\s*=\s*'pg_trgm'\)\s*THEN[\s\S]*?END IF;\s*END\s*\$\$;/gi, '');
  if (/gin_trgm_ops/i.test(withoutGuards)) throw new Error(`${file}: unguarded gin_trgm_ops`);
}
