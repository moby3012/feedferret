// Opt-in: run against a disposable schema only.
import { writeFileSync } from "node:fs";
import { it, expect } from "vitest";
import { PrismaClient } from "@prisma/client";
import { PrismaBetterSqlite3 } from "@prisma/adapter-better-sqlite3";
import { PrismaPg } from "@prisma/adapter-pg";
import { backfillExternalIds } from "../lib/external-id-store";
it.skipIf(!process.env.BACKFILL_BENCH_URL)("backfills 100k legacy rows", async () => {
  const url = process.env.BACKFILL_BENCH_URL!;
  const db = new PrismaClient({ adapter: url.startsWith("file:") ? new PrismaBetterSqlite3({ url }) : new PrismaPg({ connectionString: url }) });
  try {
    await db.user.create({ data: { id: "bench", email: "bench@example.org" } });
    await db.feed.create({ data: { id: "bench", userId: "bench", url: "https://example.org", name: "Bench" } });
    for (let i = 0; i < 100000; i += 500) await db.article.createMany({ data: Array.from({ length: 500 }, (_, j) => ({ id: `bench${i + j}`, userId: "bench", feedId: "bench", title: "Bench", content: "", link: "https://example.org", publishedAt: new Date(0) })) });
    const start = performance.now();
    await backfillExternalIds(db);
    const seconds = (performance.now() - start) / 1000;
    if (process.env.BACKFILL_BENCH_RESULT) writeFileSync(process.env.BACKFILL_BENCH_RESULT, JSON.stringify({ provider: url.startsWith("file:") ? "SQLite" : "Postgres", rows: 100000, batchSize: 500, seconds }));
    console.log(`Backfill: ${seconds.toFixed(3)} seconds`);
    expect(await db.article.count({ where: { extId: null } })).toBe(0);
    expect(await db.article.count()).toBe(100000);
  } finally { await db.$disconnect(); }
}, 180000);
