import { describe, expect, it } from 'vitest';
import { assertParity, assertSafeSql, guardTrgm } from '../../scripts/migration-utils.mjs';

describe('migration policy', () => {
  it('keeps provider histories in lockstep', () => { expect(() => assertParity()).not.toThrow(); });
  it.each([
    'DROP TABLE "User";', 'ALTER TABLE "User" DROP COLUMN email;',
    'ALTER TABLE "User" ALTER COLUMN email TYPE TEXT;', '-- RedefineTables\nSELECT 1;',
    'ALTER TABLE "User" DROP CONSTRAINT something;',
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
