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
  const destructive = /\bDROP\s+(?:TABLE|COLUMN|INDEX|SCHEMA|TYPE|VIEW|TRIGGER|EXTENSION|CONSTRAINT|SEQUENCE|FUNCTION)\b|\bALTER\s+TABLE\b[^;]*\bDROP\b|\bALTER\s+COLUMN\s+"?\w+"?\s+(?:SET\s+DATA\s+)?TYPE\b|\bALTER\s+TYPE\b|\bTRUNCATE\b|\bDELETE\s+FROM\b|\bUPDATE\s+"?\w+"?\s+SET\b|\bRENAME\s+(?:COLUMN|TO)\b/i.test(code)
    || /RedefineTables/.test(sql);
  if (destructive && !/^[ \t]*-- ff:allow-destructive[ \t]+\S[^\n]*$/m.test(sql)) {
    throw new Error(`${file}: destructive SQL needs -- ff:allow-destructive <reason>`);
  }
  // Every trigram index must be inside an extension-existence DO block.
  const withoutGuards = code.replace(/DO\s+\$\$\s*BEGIN\s+IF EXISTS\s*\(SELECT 1 FROM pg_extension WHERE extname\s*=\s*'pg_trgm'\)\s*THEN[\s\S]*?END IF;\s*END\s*\$\$;/gi, '');
  if (/gin_trgm_ops/i.test(withoutGuards)) throw new Error(`${file}: unguarded gin_trgm_ops`);
}

// ── Pure-DDL allowlist (startup adoption of db-push databases, scripts/db-migrate.mjs) ──
// A migration may be marked applied WITHOUT running it only if pushing the schema does
// exactly what the migration would do: plain object creation. Anything else (INSERT /
// UPDATE / DELETE backfills, drops, renames, type changes, functions, arbitrary DO blocks,
// PRAGMA, RedefineTables) is rejected, even with `-- ff:allow-destructive`.
const ALLOWED_DO_BLOCKS = [
  // guardTrgm(): create the extension, tolerate missing privileges
  /^DO \$\$ BEGIN CREATE EXTENSION IF NOT EXISTS pg_trgm; EXCEPTION WHEN insufficient_privilege OR undefined_file OR feature_not_supported THEN RAISE NOTICE 'pg_trgm unavailable'; END \$\$$/i,
  // guardTrgm(): trigram indexes only when the extension exists
  /^DO \$\$ BEGIN IF EXISTS \(SELECT 1 FROM pg_extension WHERE extname = 'pg_trgm'\) THEN (?:CREATE INDEX IF NOT EXISTS "\w+" ON "\w+" USING GIN \("\w+" gin_trgm_ops\); ?)+END IF; END \$\$$/i,
  // guardTrgm(): restricted-role-safe CREATE SCHEMA
  /^DO \$\$ BEGIN IF NOT EXISTS \(SELECT 1 FROM pg_namespace WHERE nspname = '\w+'\) THEN CREATE SCHEMA "\w+"; END IF; END \$\$$/i,
];
const IDENT = String.raw`(?:"[^"]+"|\w+)`;
const QUALIFIED = String.raw`${IDENT}(?:\.${IDENT})?`;
const ALLOWED_STATEMENTS = [
  new RegExp(String.raw`^CREATE TABLE (?:IF NOT EXISTS )?${QUALIFIED}\s*\(`, 'i'),
  new RegExp(String.raw`^CREATE (?:UNIQUE )?INDEX (?:IF NOT EXISTS )?${IDENT} ON ${QUALIFIED}(?:\s+USING \w+)?\s*\(`, 'i'),
  new RegExp(String.raw`^CREATE TYPE ${QUALIFIED} AS ENUM\s*\(`, 'i'),
];
const ALLOWED_ALTER_CLAUSES = [
  /^ADD COLUMN\b/i,
  new RegExp(String.raw`^ADD CONSTRAINT ${IDENT} (?:FOREIGN KEY|UNIQUE)\b`, 'i'),
];
const squash = (s) => s.replace(/\s+/g, ' ').trim();
function stripParens(s) {
  let prev;
  do { prev = s; s = s.replace(/\([^()]*\)/g, ''); } while (s !== prev);
  return s;
}

/** Returns the reasons `sql` is not pure DDL (empty array = allowed). @param {string} sql */
export function pureDdlViolations(sql) {
  const problems = [];
  // Prisma's SQLite table rebuild (copy rows, drop, rename) is never plain DDL.
  if (/RedefineTables/.test(sql)) problems.push('RedefineTables (SQLite table rebuild)');
  let code = sql.replace(/\/\*[\s\S]*?\*\//g, '').replace(/--[^\n]*/g, '');
  code = code.replace(/DO\s+\$\$[\s\S]*?\$\$\s*;/gi, (block) => {
    const flat = squash(block.replace(/;\s*$/, ''));
    if (!ALLOWED_DO_BLOCKS.some((re) => re.test(flat))) problems.push(`DO block: ${flat.slice(0, 120)}`);
    return ';';
  });
  for (const raw of code.split(';')) {
    const statement = squash(raw);
    if (!statement) continue;
    // No string literals anywhere except simple DEFAULT values; never a sub-select.
    if (/\bSELECT\b/i.test(statement) || /\$\$/.test(statement)) { problems.push(statement.slice(0, 120)); continue; }
    if (ALLOWED_STATEMENTS.some((re) => re.test(statement))) continue;
    const alter = statement.match(new RegExp(String.raw`^ALTER TABLE (?:ONLY )?${QUALIFIED} (.+)$`, 'i'));
    if (alter) {
      const clauses = stripParens(alter[1].replace(/'(?:[^']|'')*'/g, "''")).split(',').map(squash);
      if (clauses.every((c) => ALLOWED_ALTER_CLAUSES.some((re) => re.test(c)))) continue;
    }
    problems.push(statement.slice(0, 120));
  }
  return problems;
}

/** @param {string} sql @param {string} file */
export function assertPureDdl(sql, file) {
  const problems = pureDdlViolations(sql);
  if (problems.length) throw new Error(`${file}: not pure DDL (cannot be adopted without running it):\n  - ${problems.join('\n  - ')}`);
}
