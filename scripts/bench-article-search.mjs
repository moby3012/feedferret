// Steady-state search comparison on the synthetic DB seeded by mark-read-scale-benchmark.
// Generate the Postgres Prisma client first. Never point PERF_BENCH_DATABASE_URL at real data.
// Temporarily restores legacy Article GIN indexes; removes only indexes it created.
import fs from "node:fs";
import { PrismaClient } from "@prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";

const url = process.env.PERF_BENCH_DATABASE_URL;
if (!url) throw new Error("PERF_BENCH_DATABASE_URL must name a disposable synthetic benchmark DB");
const db = new PrismaClient({ adapter: new PrismaPg({ connectionString: url }) });
const created = [];
const columns = ["title", "content", "excerpt", "author", "entities"];
const ci = contains => ({ contains, mode: "insensitive" });
const text = (term, projection) => {
  const fields = ["title", "content", "excerpt", "author"].map(key => ({ [key]: ci(term) }));
  return { OR: [
    ...(projection ? [{ search: { is: { OR: fields } } }] : fields),
    { link: ci(term) }, { feed: { name: ci(term) } },
    { labels: { some: { label: { name: ci(term), userId: "ua" } } } },
  ] };
};
const cases = [
  { query: "alpha 12345", where: projection => ({ AND: [text("alpha", projection), text("12345", projection)] }) },
  { query: "charlie", where: projection => text("charlie", projection) },
  { query: "title:12345", where: projection => projection ? { search: { is: { title: ci("12345") } } } : { title: ci("12345") } },
];
try {
  const users = await db.user.findMany({ select: { id: true, email: true }, orderBy: { id: "asc" } });
  if (JSON.stringify(users) !== JSON.stringify([{ id: "ua", email: "a@example.org" }, { id: "ub", email: "b@example.org" }])) {
    throw new Error("Expected the disposable synthetic mark-read benchmark fixture");
  }
  for (const column of columns) {
    const name = `Article_${column}_trgm_idx`;
    const exists = await db.$queryRawUnsafe("SELECT 1 FROM pg_indexes WHERE schemaname = current_schema() AND indexname = $1", name);
    if (!exists.length) {
      await db.$executeRawUnsafe(`CREATE INDEX "${name}" ON "Article" USING GIN ("${column}" gin_trgm_ops)`);
      created.push(name);
    }
  }
  // Normalize pending GIN entries and visibility/statistics outside the timed operations.
  await db.$executeRawUnsafe('VACUUM ANALYZE "Article"');
  await db.$executeRawUnsafe('VACUUM ANALYZE "ArticleSearch"');
  const results = { articles: await db.article.count(), search: {} };
  for (const scenario of cases) {
    const samples = { article: [], projection: [] };
    let expected;
    let count;
    for (let i = 0; i < 6; i++) {
      for (const projection of i % 2 ? [true, false] : [false, true]) {
        const start = performance.now();
        const where = { AND: [{ userId: "ua" }, scenario.where(projection)] };
        count = await db.article.count({ where });
        const page = await db.article.findMany({ where, take: 50, orderBy: [{ publishedAt: "desc" }, { id: "desc" }], select: { id: true } });
        const ms = performance.now() - start;
        const actual = JSON.stringify({ count, page });
        if (expected && expected !== actual) throw new Error(`Results differ: ${scenario.query}`);
        expected = actual;
        if (i) samples[projection ? "projection" : "article"].push(ms);
      }
    }
    results.search[scenario.query] = { count, ...Object.fromEntries(Object.entries(samples).map(([key, values]) => {
      values.sort((a, b) => a - b);
      return [key, { medianMs: Math.round(values[2] * 10) / 10, p95Ms: Math.round(values[4] * 10) / 10 }];
    })) };
  }
  console.log(JSON.stringify(results, null, 2));
  if (process.env.SEARCH_BENCH_RESULT) fs.writeFileSync(process.env.SEARCH_BENCH_RESULT, JSON.stringify(results, null, 2));
} finally {
  for (const name of created) await db.$executeRawUnsafe(`DROP INDEX IF EXISTS "${name}"`);
  await db.$disconnect();
}
