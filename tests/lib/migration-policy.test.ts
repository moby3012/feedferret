import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { assertParity, assertSafeSql, guardTrgm, pureDdlViolations } from '../../scripts/migration-utils.mjs';

describe('migration policy', () => {
  it('keeps provider histories in lockstep', () => { expect(() => assertParity()).not.toThrow(); });
  it.each([
    'DROP TABLE "User";', 'ALTER TABLE "User" DROP COLUMN email;',
    'ALTER TABLE "User" ALTER COLUMN email TYPE TEXT;', '-- RedefineTables\nSELECT 1;',
    'ALTER TABLE "User" DROP CONSTRAINT something;',
    'ALTER TABLE "User" ALTER COLUMN "email" SET DATA TYPE TEXT;', 'ALTER TYPE "Role" RENAME VALUE \'a\' TO \'b\';',
    'TRUNCATE "Article";', 'DELETE FROM "Article";', 'UPDATE "Article" SET "title" = \'x\';',
    'ALTER TABLE "User" RENAME COLUMN "a" TO "b";', 'ALTER TABLE "User" RENAME TO "Person";',
  ])('requires a reason for destructive SQL: %s', (sql) => {
    expect(() => assertSafeSql(sql, 'test')).toThrow(/allow-destructive/);
    expect(() => assertSafeSql(`-- ff:allow-destructive reviewed expand-contract cleanup\n${sql}`, 'test')).not.toThrow();
    expect(() => assertSafeSql(`-- ff:allow-destructive\n${sql}`, 'test')).toThrow();
  });
  it('preserves dollar quoting in the restricted schema guard', () => {
    const sql = guardTrgm('CREATE SCHEMA IF NOT EXISTS "public";');
    expect(sql).toContain('DO $$ BEGIN');
    expect(sql).toContain('END $$;');
    expect(sql).not.toContain('CREATE SCHEMA IF NOT EXISTS');
  });
  it('does not flag additive SQL that merely contains keywords', () => {
    expect(() => assertSafeSql('ALTER TABLE "Feed" ADD COLUMN "type" TEXT;', 'test')).not.toThrow();
    expect(() => assertSafeSql('ALTER TABLE "A" ADD CONSTRAINT "f" FOREIGN KEY ("b") REFERENCES "B"("id") ON DELETE CASCADE ON UPDATE CASCADE;', 'test')).not.toThrow();
  });
  it('ignores SQL-looking comments', () => {
    expect(() => assertSafeSql('-- DROP TABLE x;\n/* DROP COLUMN x */\nCREATE TABLE x(id TEXT);', 'test')).not.toThrow();
  });
  it('rejects unguarded trigram indexes and accepts the generated guard', () => {
    const sql = 'CREATE INDEX "test" ON "Article" USING GIN ("title" gin_trgm_ops);';
    expect(() => assertSafeSql(sql, 'test')).toThrow(/unguarded/);
    const guarded = guardTrgm(sql);
    expect(guarded).toContain('insufficient_privilege OR undefined_file OR feature_not_supported');
    expect(guarded).toContain('CREATE INDEX IF NOT EXISTS');
    expect(() => assertSafeSql(guarded, 'test')).not.toThrow();
    expect(() => assertSafeSql(`${guarded}\n${sql}`, 'test')).toThrow(/unguarded/);
  });
});

describe('pure DDL allowlist (startup adoption)', () => {
  it('accepts both real baseline migrations', () => {
    for (const p of ['sqlite', 'postgresql']) {
      expect(pureDdlViolations(readFileSync(`prisma/migrations/${p}/00000000000000_init/migration.sql`, 'utf8'))).toEqual([]);
    }
  });
  it.each([
    'CREATE TABLE "A" ("id" TEXT NOT NULL, "n" INTEGER NOT NULL DEFAULT 0, CONSTRAINT "A_pkey" PRIMARY KEY ("id"));',
    'CREATE UNIQUE INDEX "A_n_key" ON "A"("n");',
    'CREATE INDEX IF NOT EXISTS "A_n_idx" ON "A" USING GIN ("n");',
    'ALTER TABLE "User" ADD COLUMN "x" TEXT;',
    'ALTER TABLE "User" ADD COLUMN "x" TEXT, ADD COLUMN "y" INTEGER NOT NULL DEFAULT 1;',
    'ALTER TABLE "A" ADD CONSTRAINT "A_b_fkey" FOREIGN KEY ("b") REFERENCES "B"("id") ON DELETE CASCADE ON UPDATE CASCADE;',
    'CREATE TYPE "Kind" AS ENUM (\'a\', \'b\');',
    guardTrgm('CREATE INDEX "Article_title_trgm_idx" ON "Article" USING GIN ("title" gin_trgm_ops);'),
    '-- just a comment',
  ])('allows %s', (sql) => { expect(pureDdlViolations(sql)).toEqual([]); });
  it.each([
    'INSERT INTO "A" ("id") VALUES (\'x\');',
    'UPDATE "User" SET "x" = 1;',
    '-- ff:allow-destructive reviewed\nUPDATE "User" SET "x" = 1;',
    'DELETE FROM "A";',
    'DROP TABLE "A";',
    'ALTER TABLE "User" DROP COLUMN "x";',
    'ALTER TABLE "User" ADD COLUMN "x" TEXT, DROP COLUMN "y";',
    'ALTER TABLE "User" ALTER COLUMN "x" SET NOT NULL;',
    'ALTER TABLE "User" RENAME COLUMN "a" TO "b";',
    'ALTER TABLE "A" ADD CONSTRAINT "c" CHECK ("n" > 0);',
    'CREATE TABLE "B" AS SELECT * FROM "A";',
    'PRAGMA foreign_keys=OFF;',
    'DO $$ BEGIN UPDATE "User" SET "x" = 1; END $$;',
    'CREATE FUNCTION f() RETURNS int AS $$ SELECT 1 $$ LANGUAGE sql;',
    'CREATE TRIGGER t AFTER INSERT ON "A" BEGIN SELECT 1; END;',
    'ALTER TABLE "A" RENAME TO "B";',
  ])('rejects %s', (sql) => { expect(pureDdlViolations(sql).length).toBeGreaterThan(0); });
});
