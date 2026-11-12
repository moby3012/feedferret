import { readFileSync } from "node:fs";
import Database from "better-sqlite3";
import { expect, it } from "vitest";
it("adds nullable indexed schedules using pure DDL without touching article clocks", () => {
    const db = new Database(":memory:");
    try {
        db.exec('CREATE TABLE Feed (id TEXT PRIMARY KEY, autoMuted BOOLEAN DEFAULT false, archivedAt DATETIME); CREATE TABLE Article (updatedAt INTEGER); INSERT INTO Article VALUES (123);');
        const insert = db.prepare("INSERT INTO Feed (id) VALUES (?)");
        for (let i = 0; i < 100; i++) insert.run(String(i));
        db.exec(readFileSync("prisma/migrations/sqlite/20261112110000_adaptive_refresh/migration.sql", "utf8"));
        const rows = db.prepare("SELECT nextSyncAt FROM Feed").all() as { nextSyncAt: number }[];
        expect(rows.every(row => row.nextSyncAt === null)).toBe(true);
        expect(db.prepare("SELECT * FROM Article").get()).toEqual({ updatedAt: 123 });
        const plan = db.prepare('EXPLAIN QUERY PLAN SELECT id FROM Feed WHERE autoMuted = false AND archivedAt IS NULL AND nextSyncAt <= ?').all(Date.now() + 901000);
        expect(JSON.stringify(plan)).toContain("Feed_autoMuted_archivedAt_nextSyncAt_idx");
    } finally { db.close(); }
});
