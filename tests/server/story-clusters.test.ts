// K1 story clustering against a real (temporary) SQLite database: job
// (claims, idempotency, budget, isolation, concurrency), list fields,
// GET /api/app/clusters/:id, and the story read cascade.
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { PrismaClient } from "@prisma/client";
import { PrismaBetterSqlite3 } from "@prisma/adapter-better-sqlite3";

const state = vi.hoisted(() => ({ db: null as unknown as PrismaClient, session: null as null | { user: { id: string } } }));
vi.mock("@/lib/db", () => ({
  get db() {
    return state.db;
  },
  getDatabaseProvider: () => "sqlite",
}));
vi.mock("@/auth", () => ({ auth: vi.fn(async () => state.session) }));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));

import { GET as listGET } from "../../app/api/app/articles/route";
import { GET as clusterGET } from "../../app/api/app/clusters/[id]/route";
import { clusterUser, cleanupStoryClusters, reconcileCluster, runStoryClustering, PENDING_BATCH, STEP_SIZE } from "../../lib/story-clustering/job";
import { applyArticleStateOps } from "../../server/articles/state";
import { getReadingPreferences, updateGlobalSettings } from "../../app/actions/settings";
import { markArticleIdsRead, markListRangeRead } from "../../app/actions/article-state";
import { MAX_RANGE_IDS } from "../../server/articles/mark-range";
import { markArticlesAsUnread } from "../../app/actions/feeds";
import type { ArticlePage, ClusterDetail } from "../../features/articles/types";

const dir = mkdtempSync(join(tmpdir(), "feedferret-story-"));
const NOW = Date.UTC(2026, 10, 10, 12, 0, 0);
const H = 3_600_000;
const ids = { alice: "", bob: "", aF: [] as string[], bF: [] as string[] };

const EZB = ["EZB senkt Leitzins um 0,25 Prozentpunkte", "Zinswende: Europäische Zentralbank senkt Leitzins erneut", "EZB-Zinsentscheid: Leitzins sinkt auf 2,0 Prozent"];

async function addArticle(userId: string, feedId: string, id: string, title: string, hoursAgo: number, extra: Record<string, unknown> = {}) {
  return state.db.article.create({
    data: {
      id,
      userId,
      feedId,
      title,
      link: `https://example.test/${id}`,
      content: `<p>${title}</p>`,
      excerpt: title,
      publishedAt: new Date(NOW - hoursAgo * H),
      ...extra,
    },
  });
}

beforeAll(async () => {
  const url = `file:${join(dir, "test.db")}`;
  execFileSync("pnpm", ["exec", "prisma", "db", "push", "--schema", "prisma/schema.generated.prisma"], {
    env: { ...process.env, DATABASE_PROVIDER: "sqlite", DATABASE_URL: url },
    stdio: "pipe",
  });
  state.db = new PrismaClient({ adapter: new PrismaBetterSqlite3({ url }) });
  const alice = await state.db.user.create({ data: { email: "alice@test", name: "Alice" } });
  const bob = await state.db.user.create({ data: { email: "bob@test", name: "Bob" } });
  ids.alice = alice.id;
  ids.bob = bob.id;
  for (let i = 0; i < 4; i++) {
    ids.aF.push((await state.db.feed.create({ data: { name: `A${i}`, url: `https://a${i}.test/feed`, userId: alice.id } })).id);
    ids.bF.push((await state.db.feed.create({ data: { name: `B${i}`, url: `https://b${i}.test/feed`, userId: bob.id } })).id);
  }
}, 60_000);

afterAll(async () => {
  await state.db?.$disconnect();
  rmSync(dir, { recursive: true, force: true });
});

beforeEach(() => {
  state.session = { user: { id: ids.alice } };
  delete process.env.DISABLE_STORY_CLUSTERING;
});

async function resetUser(userId: string) {
  await state.db.article.deleteMany({ where: { userId } });
  await state.db.storyCluster.deleteMany({ where: { userId } });
}

describe("clusterUser", () => {
  beforeAll(async () => {
    // alice: EZB story over 3 feeds + an unrelated article; bob: the same EZB headlines in his own feeds
    await addArticle(ids.alice, ids.aF[0], "a-ezb-0", EZB[0], 5);
    await addArticle(ids.alice, ids.aF[1], "a-ezb-1", EZB[1], 4);
    await addArticle(ids.alice, ids.aF[2], "a-ezb-2", EZB[2], 3);
    await addArticle(ids.alice, ids.aF[3], "a-other", "Bayern München gewinnt 3:1 gegen Dortmund", 2);
    await addArticle(ids.alice, ids.aF[0], "a-old", "EZB senkt Leitzins nach Sitzung in Frankfurt", 100); // outside the 48h window
    await addArticle(ids.bob, ids.bF[0], "b-ezb-0", EZB[0], 5);
    await addArticle(ids.bob, ids.bF[1], "b-ezb-1", EZB[1], 4);
  });

  it("clusters the story, leaves singletons unclustered, stores signatures, ignores rows outside the window", async () => {
    const r = await clusterUser(ids.alice, { budgetMs: 5_000, now: NOW });
    // ezb-0 is a singleton until ezb-1 pairs with it (create), ezb-2 joins; the Bayern item stays single
    expect(r).toMatchObject({ processed: 4, created: 1, joined: 1, singles: 2, morePending: false, expired: 1 });
    const rows = await state.db.article.findMany({ where: { userId: ids.alice }, orderBy: { id: "asc" } });
    const ezb = rows.filter((a) => a.id.startsWith("a-ezb"));
    expect(new Set(ezb.map((a) => a.clusterId)).size).toBe(1);
    expect(ezb[0].clusterId).toBeTruthy();
    const other = rows.find((a) => a.id === "a-other")!;
    expect(other.clusterId).toBeNull();
    expect(other.clusteredAt).not.toBeNull(); // processed singleton
    expect(other.storySig).toContain('"v":1');
    const old = rows.find((a) => a.id === "a-old")!;
    expect(old.clusteredAt).not.toBeNull(); // older than the window: settled without a cluster, never pending forever
    expect(old.clusterId).toBeNull();
    expect(old.storySig).toBeNull();
    const cluster = await state.db.storyCluster.findUniqueOrThrow({ where: { id: ezb[0].clusterId! } });
    expect(cluster).toMatchObject({ userId: ids.alice, size: 3, feedCount: 3, algoVersion: 1 });
    expect(ezb.map((a) => a.id)).toContain(cluster.leadArticleId);
    expect(cluster.firstSeenAt.getTime()).toBe(NOW - 5 * H);
    expect(cluster.lastSeenAt.getTime()).toBe(NOW - 3 * H);
    expect(cluster.sig.length).toBeLessThanOrEqual(2048);
  });

  it("is idempotent: a second run changes nothing", async () => {
    const before = await state.db.article.findMany({ where: { userId: ids.alice }, orderBy: { id: "asc" }, select: { id: true, clusterId: true, clusteredAt: true, storySig: true } });
    const r = await clusterUser(ids.alice, { budgetMs: 5_000, now: NOW });
    expect(r.processed).toBe(0);
    const after = await state.db.article.findMany({ where: { userId: ids.alice }, orderBy: { id: "asc" }, select: { id: true, clusterId: true, clusteredAt: true, storySig: true } });
    expect(after).toEqual(before);
    expect(await state.db.storyCluster.count({ where: { userId: ids.alice } })).toBe(1);
  });

  it("keeps users isolated: bob's identical headlines form bob's own cluster", async () => {
    await clusterUser(ids.bob, { budgetMs: 5_000, now: NOW });
    const bobRows = await state.db.article.findMany({ where: { userId: ids.bob } });
    const bobCluster = bobRows[0].clusterId!;
    expect(bobRows.every((a) => a.clusterId === bobCluster)).toBe(true);
    const aliceClusterIds = (await state.db.storyCluster.findMany({ where: { userId: ids.alice } })).map((c) => c.id);
    expect(aliceClusterIds).not.toContain(bobCluster);
    const members = await state.db.article.findMany({ where: { clusterId: bobCluster } });
    expect(members.every((a) => a.userId === ids.bob)).toBe(true);
  });

  it("a later source joins the existing cluster and can become its lead", async () => {
    await addArticle(ids.alice, ids.aF[3], "a-ezb-3", "EZB-Entscheid: Leitzins sinkt, Märkte reagieren", 1, { imageUrl: "https://img.test/1.jpg", readMinutes: 4 });
    const r = await clusterUser(ids.alice, { budgetMs: 5_000, now: NOW });
    expect(r).toMatchObject({ processed: 1, joined: 1 });
    const cluster = await state.db.storyCluster.findFirstOrThrow({ where: { userId: ids.alice } });
    expect(cluster.size).toBe(4);
    expect(cluster.feedCount).toBe(4);
    expect(cluster.lastSeenAt.getTime()).toBe(NOW - 1 * H);
    expect(await state.db.article.count({ where: { clusterId: cluster.id } })).toBe(4);
    expect(cluster.leadArticleId).toBe("a-ezb-3"); // image + long read outrank the others
  });

  it("two concurrent runs never double-assign: clusters stay consistent", async () => {
    await resetUser(ids.alice);
    await addArticle(ids.alice, ids.aF[0], "c-0", EZB[0], 5);
    await addArticle(ids.alice, ids.aF[1], "c-1", EZB[1], 4);
    await addArticle(ids.alice, ids.aF[2], "c-2", EZB[2], 3);
    await Promise.all([clusterUser(ids.alice, { budgetMs: 5_000, now: NOW }), clusterUser(ids.alice, { budgetMs: 5_000, now: NOW })]);
    const clusters = await state.db.storyCluster.findMany({ where: { userId: ids.alice }, include: { _count: { select: { articles: true } } } });
    expect(clusters).toHaveLength(1);
    expect(clusters[0].size).toBe(clusters[0]._count.articles);
    expect(await state.db.article.count({ where: { userId: ids.alice, clusteredAt: null } })).toBe(0);
  });

  it("respects the time budget: a spent budget still advances one step, the rest stays pending for the next tick", async () => {
    await resetUser(ids.alice);
    const total = STEP_SIZE * 2 + 20;
    await state.db.article.createMany({
      data: Array.from({ length: total }, (_, i) => ({
        id: `p-${String(i).padStart(3, "0")}`,
        userId: ids.alice,
        feedId: ids.aF[i % 4],
        title: `Unrelated headline number ${i} about topic${i}x${i * 7} subject${i}y`,
        link: `https://example.test/p-${i}`,
        content: "<p>x</p>",
        publishedAt: new Date(NOW - (i % 40) * H),
      })),
    });
    const first = await clusterUser(ids.alice, { budgetMs: 0, now: NOW });
    expect(first.processed).toBe(STEP_SIZE);
    expect(first.morePending).toBe(true);
    expect(await state.db.article.count({ where: { userId: ids.alice, clusteredAt: null } })).toBe(total - STEP_SIZE);
    let guard = 0;
    while ((await clusterUser(ids.alice, { budgetMs: 10_000, now: NOW })).processed > 0 && guard++ < 10);
    expect(await state.db.article.count({ where: { userId: ids.alice, clusteredAt: null } })).toBe(0);
  });

  it("caps the pending batch per round", async () => {
    await resetUser(ids.alice);
    const total = PENDING_BATCH + 30;
    await state.db.article.createMany({
      data: Array.from({ length: total }, (_, i) => ({
        id: `q-${String(i).padStart(3, "0")}`,
        userId: ids.alice,
        feedId: ids.aF[i % 4],
        title: `Distinct item ${i} qwerty${i}z asdf${i * 3}w`,
        link: `https://example.test/q-${i}`,
        content: "<p>x</p>",
        publishedAt: new Date(NOW - (i % 40) * H),
      })),
    });
    const r = await clusterUser(ids.alice, { budgetMs: 10_000, now: NOW });
    expect(r.processed).toBe(PENDING_BATCH);
    expect(r.morePending).toBe(true);
  });
});

describe("Article.updatedAt is not a clustering side effect (GReader ot / updated)", () => {
  const T0 = new Date(NOW - 10 * 24 * H); // long before any clustering write
  const updatedAtOf = async (id: string) => (await state.db.article.findUniqueOrThrow({ where: { id } })).updatedAt.getTime();
  beforeEach(() => resetUser(ids.alice));

  it("singleton claim, join claim and partner write all leave updatedAt unchanged", async () => {
    // u-0 + u-1 form a cluster (create), u-2 joins it, u-3 stays a singleton
    await addArticle(ids.alice, ids.aF[0], "u-0", EZB[0], 5, { updatedAt: T0 });
    await addArticle(ids.alice, ids.aF[1], "u-1", EZB[1], 4, { updatedAt: T0 });
    await addArticle(ids.alice, ids.aF[2], "u-2", EZB[2], 3, { updatedAt: T0 });
    await addArticle(ids.alice, ids.aF[3], "u-3", "Bayern München gewinnt 3:1 gegen Dortmund", 2, { updatedAt: T0 });
    await clusterUser(ids.alice, { budgetMs: 5_000, now: NOW });
    const rows = await state.db.article.findMany({ where: { userId: ids.alice }, orderBy: { id: "asc" } });
    expect(rows.every((r) => r.clusteredAt !== null)).toBe(true);
    expect(rows.filter((r) => r.clusterId).length).toBe(3); // create (+ partner) and join
    expect(rows.find((r) => r.id === "u-3")!.clusterId).toBeNull(); // singleton
    for (const r of rows) expect(r.updatedAt.getTime(), r.id).toBe(T0.getTime());
  });

  it("partner of a later create: the already-processed singleton gets its clusterId without a new updatedAt", async () => {
    await addArticle(ids.alice, ids.aF[0], "p-0", EZB[0], 5, { updatedAt: T0 });
    await clusterUser(ids.alice, { budgetMs: 5_000, now: NOW }); // p-0 → processed singleton
    expect((await state.db.article.findUniqueOrThrow({ where: { id: "p-0" } })).clusterId).toBeNull();
    await addArticle(ids.alice, ids.aF[1], "p-1", EZB[1], 4, { updatedAt: T0 });
    await clusterUser(ids.alice, { budgetMs: 5_000, now: NOW });
    const p0 = await state.db.article.findUniqueOrThrow({ where: { id: "p-0" } });
    expect(p0.clusterId).not.toBeNull();
    expect(p0.updatedAt.getTime()).toBe(T0.getTime());
    expect(await updatedAtOf("p-1")).toBe(T0.getTime());
  });

  it("a row changed between read and write (read toggle) is retried and keeps the NEW updatedAt", async () => {
    await addArticle(ids.alice, ids.aF[0], "r-0", "Bayern München gewinnt 3:1 gegen Dortmund", 2, { updatedAt: T0 });
    const original = state.db.$transaction.bind(state.db);
    let bumped: Date | null = null;
    const spy = vi.spyOn(state.db, "$transaction").mockImplementationOnce((async (ops: unknown) => {
      bumped = (await state.db.article.update({ where: { id: "r-0" }, data: { isStarred: true } })).updatedAt; // concurrent user action
      return original(ops as never);
    }) as never);
    await clusterUser(ids.alice, { budgetMs: 5_000, now: NOW });
    spy.mockRestore();
    const row = await state.db.article.findUniqueOrThrow({ where: { id: "r-0" } });
    expect(row.clusteredAt).not.toBeNull(); // the retry claimed it
    expect(row.isStarred).toBe(true);
    expect(bumped).not.toBeNull();
    expect(row.updatedAt.getTime()).toBe(bumped!.getTime()); // the user's modification time, not T0, not the claim time
    expect(row.updatedAt.getTime()).toBeGreaterThan(T0.getTime());
  });

  it("lost partner race: a cluster that ends up with one member is dissolved instead of keeping size 2", async () => {
    await addArticle(ids.alice, ids.aF[0], "x-0", EZB[0], 5, { updatedAt: T0 });
    await clusterUser(ids.alice, { budgetMs: 5_000, now: NOW }); // x-0 processed singleton
    await state.db.storyCluster.create({
      data: { id: "other", userId: ids.alice, leadArticleId: "x-0", size: 2, feedCount: 2, firstSeenAt: new Date(NOW), lastSeenAt: new Date(NOW), sig: "{}" },
    });
    await addArticle(ids.alice, ids.aF[1], "x-1", EZB[1], 4, { updatedAt: T0 });
    // another instance grabs the partner right after our cluster rows were written (first transaction of the step)
    const original = state.db.$transaction.bind(state.db);
    const spy = vi.spyOn(state.db, "$transaction").mockImplementationOnce((async (ops: unknown) => {
      const res = await original(ops as never);
      await state.db.article.updateMany({ where: { id: "x-0" }, data: { clusterId: "other" } });
      return res;
    }) as never);
    await clusterUser(ids.alice, { budgetMs: 5_000, now: NOW });
    spy.mockRestore();
    const clusters = await state.db.storyCluster.findMany({ where: { userId: ids.alice, id: { not: "other" } } });
    const x1 = await state.db.article.findUniqueOrThrow({ where: { id: "x-1" } });
    for (const c of clusters) expect(await state.db.article.count({ where: { clusterId: c.id } })).toBe(c.size); // never size 2 with one member
    expect(clusters).toHaveLength(0);
    expect(x1.clusterId).toBeNull();
    expect(x1.clusteredAt).not.toBeNull();
    expect((await state.db.article.findUniqueOrThrow({ where: { id: "x-0" } })).clusterId).toBe("other");
  });
});

describe("runStoryClustering", () => {
  it("is a no-op with DISABLE_STORY_CLUSTERING=true and for users who turned it off", async () => {
    await resetUser(ids.alice);
    await addArticle(ids.alice, ids.aF[0], "d-0", EZB[0], 5);
    process.env.DISABLE_STORY_CLUSTERING = "true";
    expect((await runStoryClustering({ budgetMs: 1000, now: NOW })).disabled).toBe(true);
    expect((await state.db.article.findUniqueOrThrow({ where: { id: "d-0" } })).clusteredAt).toBeNull();
    delete process.env.DISABLE_STORY_CLUSTERING;
    await state.db.user.update({ where: { id: ids.alice }, data: { storyClustering: false } });
    await runStoryClustering({ budgetMs: 1000, now: NOW });
    expect((await state.db.article.findUniqueOrThrow({ where: { id: "d-0" } })).clusteredAt).toBeNull();
    await state.db.user.update({ where: { id: ids.alice }, data: { storyClustering: true } });
    const r = await runStoryClustering({ budgetMs: 1000, now: NOW });
    expect(r.processed).toBeGreaterThanOrEqual(1);
    expect((await state.db.article.findUniqueOrThrow({ where: { id: "d-0" } })).clusteredAt).not.toBeNull();
  });

  it("never throws: a failing query is logged and swallowed", async () => {
    const spy = vi.spyOn(state.db.user, "findMany").mockRejectedValueOnce(new Error("db down"));
    await expect(runStoryClustering({ budgetMs: 1000, now: NOW })).resolves.toMatchObject({ processed: 0 });
    spy.mockRestore();
  });

  it("runs with nothing pending: only users with pending rows are visited", async () => {
    await resetUser(ids.alice);
    await resetUser(ids.bob);
    const spy = vi.spyOn(state.db.article, "findMany");
    const r = await runStoryClustering({ budgetMs: 1000, now: NOW });
    expect(r).toMatchObject({ users: 0, processed: 0 });
    expect(spy).not.toHaveBeenCalled(); // not even a per-user pending query
    spy.mockRestore();
  });

  it("overlapping runs: the second returns at once and nothing is processed twice", async () => {
    await resetUser(ids.alice);
    await addArticle(ids.alice, ids.aF[0], "o-0", EZB[0], 5);
    await addArticle(ids.alice, ids.aF[1], "o-1", EZB[1], 4);
    await addArticle(ids.alice, ids.aF[2], "o-2", EZB[2], 3);
    const [r1, r2] = await Promise.all([runStoryClustering({ budgetMs: 5000, now: NOW }), runStoryClustering({ budgetMs: 5000, now: NOW })]);
    const processed = r1.processed + r2.processed;
    expect(processed).toBe(3); // exactly once
    expect([r1.morePending, r2.morePending].filter(Boolean)).toHaveLength(1); // the loser reports "try again"
    const clusters = await state.db.storyCluster.findMany({ where: { userId: ids.alice }, include: { _count: { select: { articles: true } } } });
    expect(clusters).toHaveLength(1);
    expect(clusters[0].size).toBe(clusters[0]._count.articles);
    expect(await state.db.article.count({ where: { userId: ids.alice, clusteredAt: null } })).toBe(0);
  });

  it("budget: the first user always advances; later users wait while the budget is spent; window load is skipped when nothing may progress", async () => {
    await resetUser(ids.alice);
    await resetUser(ids.bob);
    await addArticle(ids.alice, ids.aF[0], "u-a", EZB[0], 5);
    await addArticle(ids.bob, ids.bF[0], "u-b", EZB[0], 5);
    const spy = vi.spyOn(state.db.storyCluster, "findMany");
    const idle = await clusterUser(ids.alice, { budgetMs: 0, now: NOW, mustProgress: false });
    expect(idle).toMatchObject({ processed: 0, morePending: true });
    expect(spy).not.toHaveBeenCalled(); // window / cluster load skipped
    spy.mockRestore();
    const r = await runStoryClustering({ budgetMs: 0, now: NOW });
    expect(r).toMatchObject({ users: 1, processed: 1, morePending: true });
    const r2 = await runStoryClustering({ budgetMs: 0, now: NOW }); // rotation: the other user is next
    expect(r2).toMatchObject({ users: 1, processed: 1 });
    expect(await state.db.article.count({ where: { clusteredAt: null, id: { in: ["u-a", "u-b"] } } })).toBe(0);
  });

  it("cleanup removes stale and memberless clusters only", async () => {
    await resetUser(ids.alice);
    const mk = (id: string, daysAgo: number, extra: Record<string, unknown> = {}) =>
      state.db.storyCluster.create({
        data: { id, userId: ids.alice, leadArticleId: "k-0", size: 2, feedCount: 2, firstSeenAt: new Date(NOW - H), lastSeenAt: new Date(NOW - daysAgo * 24 * H), sig: "{}", ...extra },
      });
    await mk("keep", 1);
    await mk("stale", 20);
    await mk("empty", 1);
    await addArticle(ids.alice, ids.aF[0], "k-0", "x y z", 1, { clusterId: "keep" });
    await addArticle(ids.alice, ids.aF[2], "k-2", "x y z", 1, { clusterId: "keep" });
    await addArticle(ids.alice, ids.aF[1], "k-1", "x y z", 1, { clusterId: "stale" });
    const r = await cleanupStoryClusters(NOW);
    expect(r).toEqual({ deleted: 2, repaired: 0 }); // `keep` has 2 members and its lead: healthy
    expect((await state.db.storyCluster.findMany({ where: { userId: ids.alice } })).map((c) => c.id)).toEqual(["keep"]);
    expect((await state.db.article.findUniqueOrThrow({ where: { id: "k-1" } })).clusterId).toBeNull(); // SetNull
    // second run: nothing left to do
    expect(await cleanupStoryClusters(NOW)).toEqual({ deleted: 0, repaired: 0 });
  });
});

describe("stale clusters (daily cleanup)", () => {
  const mkCluster = (id: string, data: Record<string, unknown> = {}) =>
    state.db.storyCluster.create({
      data: { id, userId: ids.alice, leadArticleId: `${id}-0`, size: 3, feedCount: 3, firstSeenAt: new Date(NOW - 5 * H), lastSeenAt: new Date(NOW - 3 * H), sig: JSON.stringify({ t: { x: 1 }, e: [], lead: { v: 1, t: ["x"], e: [], l: [] } }), ...data },
    });
  const member = (cluster: string, i: number, extra: Record<string, unknown> = {}) =>
    addArticle(ids.alice, ids.aF[i], `${cluster}-${i}`, `story ${cluster} ${i}`, 5 - i, { clusterId: cluster, clusteredAt: new Date(NOW), storySig: JSON.stringify({ v: 1, t: ["x"], e: [], l: [], q: 1 }), ...extra });

  beforeEach(() => resetUser(ids.alice));

  it("a deleted member: size / feedCount / span are recounted", async () => {
    await mkCluster("m");
    for (const i of [0, 1, 2]) await member("m", i);
    await state.db.article.delete({ where: { id: "m-2" } }); // e.g. retention
    const r = await cleanupStoryClusters(NOW);
    expect(r).toMatchObject({ deleted: 0, repaired: 1 });
    expect(await state.db.storyCluster.findUniqueOrThrow({ where: { id: "m" } })).toMatchObject({ size: 2, feedCount: 2, leadArticleId: "m-0" });
  });

  it("members down to one: the cluster is dissolved and the remaining member loses its clusterId", async () => {
    await mkCluster("d");
    for (const i of [0, 1, 2]) await member("d", i);
    await state.db.article.deleteMany({ where: { id: { in: ["d-1", "d-2"] } } });
    const r = await cleanupStoryClusters(NOW);
    expect(r.deleted).toBe(1);
    expect(await state.db.storyCluster.findUnique({ where: { id: "d" } })).toBeNull();
    const left = await state.db.article.findUniqueOrThrow({ where: { id: "d-0" } });
    expect(left.clusterId).toBeNull();
    expect(left.clusteredAt).not.toBeNull(); // stays processed: not re-clustered into a one-member cluster
  });

  it("dangling leadArticleId: re-picked among the members (quality, then earliest)", async () => {
    await mkCluster("l");
    await member("l", 0, { storySig: JSON.stringify({ v: 1, t: ["x"], e: [], l: [], q: 1 }) });
    await member("l", 1, { storySig: JSON.stringify({ v: 1, t: ["y"], e: [], l: [], q: 3 }) });
    await member("l", 2, { storySig: JSON.stringify({ v: 1, t: ["z"], e: [], l: [], q: 2 }) });
    await state.db.article.delete({ where: { id: "l-0" } }); // the lead goes away
    const r = await cleanupStoryClusters(NOW);
    expect(r.repaired).toBe(1);
    const c = await state.db.storyCluster.findUniqueOrThrow({ where: { id: "l" } });
    expect(c.leadArticleId).toBe("l-1");
    expect(c.size).toBe(2);
    expect(JSON.parse(c.sig).lead.t).toEqual(["y"]); // the drift anchor follows the new lead
  });

  it("a healthy cluster is left alone; reconcileCluster on a missing id is a no-op", async () => {
    await mkCluster("h", { size: 2, feedCount: 2, firstSeenAt: new Date(NOW - 5 * H), lastSeenAt: new Date(NOW - 4 * H) });
    await member("h", 0);
    await member("h", 1);
    expect(await cleanupStoryClusters(NOW)).toEqual({ deleted: 0, repaired: 0 });
    expect(await reconcileCluster(ids.alice, "nope")).toBe("missing");
  });
});

describe("API contract", () => {
  let clusterId = "";
  beforeAll(async () => {
    await resetUser(ids.alice);
    await resetUser(ids.bob);
    await addArticle(ids.alice, ids.aF[0], "x-0", EZB[0], 5);
    await addArticle(ids.alice, ids.aF[1], "x-1", EZB[1], 4);
    await addArticle(ids.alice, ids.aF[2], "x-2", EZB[2], 3);
    await addArticle(ids.alice, ids.aF[3], "x-other", "Bayern München gewinnt 3:1 gegen Dortmund", 2);
    await addArticle(ids.bob, ids.bF[0], "y-0", EZB[0], 5);
    await addArticle(ids.bob, ids.bF[1], "y-1", EZB[1], 4);
    await clusterUser(ids.alice, { budgetMs: 5_000, now: NOW });
    await clusterUser(ids.bob, { budgetMs: 5_000, now: NOW });
    clusterId = (await state.db.article.findUniqueOrThrow({ where: { id: "x-0" } })).clusterId!;
  });

  async function list(): Promise<ArticlePage> {
    const res = await listGET(new Request("https://ff.test/api/app/articles?show=all&limit=100"));
    return (await res.json()) as ArticlePage;
  }
  async function detail(id: string, asUser = ids.alice) {
    state.session = { user: { id: asUser } };
    const res = await clusterGET(new Request(`https://ff.test/api/app/clusters/${id}`), { params: Promise.resolve({ id }) });
    return { status: res.status, body: (await res.json()) as ClusterDetail & { error?: unknown } };
  }

  it("list items carry clusterId / clusterSize / clusterLeadId only for clustered rows; existing fields are unchanged", async () => {
    const page = await list();
    const byId = new Map(page.items.map((i) => [i.id, i]));
    const lead = (await state.db.storyCluster.findUniqueOrThrow({ where: { id: clusterId } })).leadArticleId;
    for (const id of ["x-0", "x-1", "x-2"]) expect(byId.get(id)).toMatchObject({ clusterId, clusterSize: 3, clusterLeadId: lead });
    const single = byId.get("x-other")!;
    expect("clusterId" in single).toBe(false);
    expect("clusterSize" in single).toBe(false);
    expect(single).toMatchObject({ id: "x-other", title: expect.any(String), isRead: false, duplicateCount: 0, labelIds: [] });
    expect(page.items.find((i) => i.id.startsWith("y-"))).toBeUndefined(); // bob's rows never leak
  });

  it("GET /api/app/clusters/:id returns the user's members as slim list rows, oldest first", async () => {
    const { status, body } = await detail(clusterId);
    expect(status).toBe(200);
    expect(body.id).toBe(clusterId);
    expect(body.size).toBe(3);
    expect(body.members.map((m) => m.id)).toEqual(["x-0", "x-1", "x-2"]);
    expect(body.members[0]).not.toHaveProperty("content");
    expect(body.members[0]).not.toHaveProperty("html");
    expect(body.members[0]).toMatchObject({ clusterId, clusterSize: 3, clusterLeadId: body.leadId });
    expect(body.members.map((m) => m.id)).toContain(body.leadId);
  });

  it("is user-scoped: 401 without session, 404 for another user's or an unknown cluster", async () => {
    state.session = null;
    const anon = await clusterGET(new Request(`https://ff.test/api/app/clusters/${clusterId}`), { params: Promise.resolve({ id: clusterId }) });
    expect(anon.status).toBe(401);
    expect((await detail(clusterId, ids.bob)).status).toBe(404);
    expect((await detail("nope")).status).toBe(404);
    expect((await detail("x".repeat(200))).status).toBe(404);
    state.session = { user: { id: ids.alice } };
  });
});

describe("story read cascade (clusterReadMode)", () => {
  let lead = "";
  let members: string[] = [];
  beforeEach(async () => {
    await resetUser(ids.alice);
    await resetUser(ids.bob);
    await state.db.user.update({ where: { id: ids.alice }, data: { clusterReadMode: "story" } });
    await addArticle(ids.alice, ids.aF[0], "s-0", EZB[0], 5);
    await addArticle(ids.alice, ids.aF[1], "s-1", EZB[1], 4);
    await addArticle(ids.alice, ids.aF[2], "s-2", EZB[2], 3);
    await addArticle(ids.alice, ids.aF[3], "s-other", "Bayern München gewinnt 3:1 gegen Dortmund", 2);
    await addArticle(ids.bob, ids.bF[0], "t-0", EZB[0], 5);
    await addArticle(ids.bob, ids.bF[1], "t-1", EZB[1], 4);
    await clusterUser(ids.alice, { budgetMs: 5_000, now: NOW });
    await clusterUser(ids.bob, { budgetMs: 5_000, now: NOW });
    const c = await state.db.storyCluster.findFirstOrThrow({ where: { userId: ids.alice } });
    lead = c.leadArticleId;
    members = ["s-0", "s-1", "s-2"].filter((id) => id !== lead);
  });
  const isRead = async (id: string) => (await state.db.article.findUniqueOrThrow({ where: { id } })).isRead;

  it("marking the lead read marks the other sources read and reports them as affected", async () => {
    const res = await applyArticleStateOps(ids.alice, [{ id: lead, isRead: true }]);
    expect(res.failed).toEqual([]);
    expect(res.affected.sort()).toEqual(members.sort());
    for (const id of ["s-0", "s-1", "s-2"]) expect(await isRead(id)).toBe(true);
    expect(await isRead("s-other")).toBe(false);
    expect(await isRead("t-0")).toBe(false); // bob's identical story untouched
    expect((await state.db.article.findUniqueOrThrow({ where: { id: members[0] } })).readAt).toBeInstanceOf(Date);
  });

  it("does not cascade from a non-lead source, for isRead:false, or already-read members", async () => {
    expect((await applyArticleStateOps(ids.alice, [{ id: members[0], isRead: true }])).affected).toEqual([]);
    expect(await isRead(lead)).toBe(false);
    await state.db.article.update({ where: { id: members[1] }, data: { isRead: true } });
    const res = await applyArticleStateOps(ids.alice, [{ id: lead, isRead: true }]);
    expect(res.affected).not.toContain(members[1]); // was read already
    expect((await applyArticleStateOps(ids.alice, [{ id: lead, isRead: false }])).affected).toEqual([]);
  });

  it("does not cascade when the setting is 'article'", async () => {
    await state.db.user.update({ where: { id: ids.alice }, data: { clusterReadMode: "article" } });
    const res = await applyArticleStateOps(ids.alice, [{ id: lead, isRead: true }]);
    expect(res.affected).toEqual([]);
    for (const id of members) expect(await isRead(id)).toBe(false);
  });

  it("an explicit op for a member in the same batch wins over the cascade", async () => {
    const res = await applyArticleStateOps(ids.alice, [{ id: lead, isRead: true }, { id: members[0], isStarred: true }]);
    expect(res.affected).toEqual([members[1]]);
    expect(await isRead(members[0])).toBe(false);
    expect(await isRead(members[1])).toBe(true);
  });

  it("last op per id decides: [read, unread, read] cascades, [read, unread] does not", async () => {
    const res = await applyArticleStateOps(ids.alice, [{ id: lead, isRead: true }, { id: lead, isRead: false }, { id: lead, isRead: true }]);
    expect(res.affected.sort()).toEqual(members.sort());
    expect(await isRead(lead)).toBe(true);
    for (const id of members) expect(await isRead(id)).toBe(true);
    // reset and try the other order
    await state.db.article.updateMany({ where: { userId: ids.alice }, data: { isRead: false } });
    const none = await applyArticleStateOps(ids.alice, [{ id: lead, isRead: true }, { id: lead, isRead: false }]);
    expect(none.affected).toEqual([]);
    expect(await isRead(lead)).toBe(false);
    for (const id of members) expect(await isRead(id)).toBe(false);
    // an interleaved star op for the lead does not hide its isRead history
    const mixed = await applyArticleStateOps(ids.alice, [{ id: lead, isRead: true }, { id: lead, isStarred: true }]);
    expect(mixed.affected.sort()).toEqual(members.sort());
  });

  it("is user-scoped: another user's lead id cascades nothing and is reported failed", async () => {
    const res = await applyArticleStateOps(ids.bob, [{ id: lead, isRead: true }]);
    expect(res).toEqual({ failed: [lead], affected: [], cascades: [] });
    for (const id of ["s-0", "s-1", "s-2"]) expect(await isRead(id)).toBe(false);
  });
});

describe("story cascade: per-story groups and story-card ops (story: true)", () => {
  const isRead = async (id: string) => (await state.db.article.findUniqueOrThrow({ where: { id } })).isRead;
  /** A hand-built cluster (deterministic, no clustering heuristics involved). */
  async function story(userId: string, feeds: string[], prefix: string, size: number, leadIndex = 0) {
    const articleIds: string[] = [];
    for (let i = 0; i < size; i++) articleIds.push((await addArticle(userId, feeds[i % feeds.length], `${prefix}-${i}`, `${prefix} headline ${i}`, 10 - i)).id);
    const cluster = await state.db.storyCluster.create({
      data: { userId, leadArticleId: articleIds[leadIndex], size, feedCount: size, firstSeenAt: new Date(NOW - 10 * H), lastSeenAt: new Date(NOW), sig: "{}" },
    });
    await state.db.article.updateMany({ where: { id: { in: articleIds } }, data: { clusterId: cluster.id } });
    return { clusterId: cluster.id, lead: articleIds[leadIndex], ids: articleIds };
  }

  beforeEach(async () => {
    await resetUser(ids.alice);
    await resetUser(ids.bob);
    await state.db.user.update({ where: { id: ids.alice }, data: { clusterReadMode: "story" } });
  });

  it("two stories in one batch: cascade ids come back grouped by the story that caused them", async () => {
    const a = await story(ids.alice, ids.aF, "ga", 3);
    const b = await story(ids.alice, ids.aF, "gb", 4);
    const res = await applyArticleStateOps(ids.alice, [{ id: a.lead, isRead: true }, { id: b.lead, isRead: true }]);
    const byOrigin = Object.fromEntries(res.cascades.map((c) => [c.origin, c.ids.sort()]));
    expect(byOrigin).toEqual({ [a.lead]: a.ids.filter((x) => x !== a.lead).sort(), [b.lead]: b.ids.filter((x) => x !== b.lead).sort() });
    expect(res.cascades.find((c) => c.origin === a.lead)?.clusterId).toBe(a.clusterId);
    expect(res.affected.sort()).toEqual(res.cascades.flatMap((c) => c.ids).sort());
  });

  it("a story card standing for a NON-lead source cascades with story: true (and only then)", async () => {
    const a = await story(ids.alice, ids.aF, "nl", 3, 0);
    const rep = a.ids[2];
    expect((await applyArticleStateOps(ids.alice, [{ id: rep, isRead: true }])).cascades).toEqual([]);
    expect(await isRead(a.lead)).toBe(false);
    await state.db.article.update({ where: { id: rep }, data: { isRead: false, readAt: null } });
    const res = await applyArticleStateOps(ids.alice, [{ id: rep, isRead: true, story: true }]);
    expect(res.cascades).toEqual([{ origin: rep, clusterId: a.clusterId, ids: [a.ids[0], a.ids[1]].sort() }]);
    for (const id of a.ids) expect(await isRead(id)).toBe(true);
  });

  it("lead and story-card source of the same story in one batch: one group, attributed to the lead", async () => {
    const a = await story(ids.alice, ids.aF, "one", 4, 1);
    const res = await applyArticleStateOps(ids.alice, [{ id: a.ids[3], isRead: true, story: true }, { id: a.lead, isRead: true }]);
    expect(res.cascades).toHaveLength(1);
    expect(res.cascades[0].origin).toBe(a.lead);
    expect(res.cascades[0].ids.sort()).toEqual([a.ids[0], a.ids[2]].sort());
  });

  it("story: true is user-scoped (foreign id fails, nothing cascades), needs isRead: true and the 'story' mode", async () => {
    const a = await story(ids.alice, ids.aF, "us", 3);
    expect(await applyArticleStateOps(ids.bob, [{ id: a.ids[1], isRead: true, story: true }])).toEqual({ failed: [a.ids[1]], affected: [], cascades: [] });
    for (const id of a.ids) expect(await isRead(id)).toBe(false);
    expect((await applyArticleStateOps(ids.alice, [{ id: a.ids[1], isRead: false, story: true }])).cascades).toEqual([]);
    await state.db.user.update({ where: { id: ids.alice }, data: { clusterReadMode: "article" } });
    expect((await applyArticleStateOps(ids.alice, [{ id: a.ids[1], isRead: true, story: true }])).cascades).toEqual([]);
    expect(await isRead(a.ids[0])).toBe(false);
  });
});

describe("markListRangeRead (\"Alles bis hier\" as a server-side range)", () => {
  const isRead = async (id: string) => (await state.db.article.findUniqueOrThrow({ where: { id } })).isRead;
  const feedKey = () => `/?feed=${ids.aF[0]}`;
  let rows: string[] = [];
  let maxCreatedAt = 0;

  beforeEach(async () => {
    await resetUser(ids.alice);
    await resetUser(ids.bob);
    rows = [];
    // 1200 rows in one feed, newest first = r-0000 … r-1199 (beyond the 1000-id cap of the id path).
    const base = Date.now() - 60_000;
    await state.db.article.createMany({
      data: Array.from({ length: 1200 }, (_, i) => ({
        id: `r-${String(i).padStart(4, "0")}`,
        userId: ids.alice,
        feedId: ids.aF[0],
        title: `Row ${i}`,
        link: `https://example.test/r-${i}`,
        content: "",
        excerpt: "",
        publishedAt: new Date(NOW - i * 60_000),
        createdAt: new Date(base),
      })),
    });
    for (let i = 0; i < 1200; i++) rows.push(`r-${String(i).padStart(4, "0")}`);
    maxCreatedAt = base;
    await addArticle(ids.alice, ids.aF[1], "r-other-feed", "Other feed", 0.5);
  });

  it("marks every unread row from the top down to toId (inclusive, > 1000) with ONE undo token", async () => {
    await state.db.article.update({ where: { id: rows[5] }, data: { isRead: true, readAt: new Date(NOW - 99 * H) } });
    const result = await markListRangeRead({ listKey: feedKey(), sort: "new", fromId: rows[0], toId: rows[1099], maxCreatedAt, extraIds: [] });
    expect(result.ids).toHaveLength(1099); // 1100 rows, one was read already
    expect(result.undoToken).toEqual(expect.any(String));
    expect(await isRead(rows[1099])).toBe(true);
    expect(await isRead(rows[1100])).toBe(false);
    expect(await isRead("r-other-feed")).toBe(false); // other scope
    expect((await state.db.article.findUniqueOrThrow({ where: { id: rows[5] } })).readAt?.getTime()).toBe(NOW - 99 * H);
    const undone = await markArticlesAsUnread(result.undoToken!);
    expect(undone.ids).toHaveLength(1099);
    expect(await isRead(rows[0])).toBe(false);
    expect(await isRead(rows[5])).toBe(true);
  });

  it("follows the list order (sort=old reverses the range) and adds folded extra ids", async () => {
    const result = await markListRangeRead({ listKey: feedKey(), sort: "old", fromId: rows[1199], toId: rows[1190], maxCreatedAt, extraIds: [rows[3]] });
    expect(result.ids.sort()).toEqual([...rows.slice(1190), rows[3]].sort());
  });

  it("never marks rows that arrived after the list was loaded (newer createdAt), even inside the range", async () => {
    await addArticle(ids.alice, ids.aF[0], "r-late", "Late backdated arrival", (NOW - (NOW - 10 * 60_000)) / H, { createdAt: new Date(maxCreatedAt + 5_000) });
    const result = await markListRangeRead({ listKey: feedKey(), sort: "new", fromId: rows[0], toId: rows[50], maxCreatedAt, extraIds: [] });
    expect(result.ids).toHaveLength(51);
    expect(await isRead("r-late")).toBe(false);
  });

  it("the first list page carries a server snapshot time; a cutoff at it keeps later (also backdated) arrivals out", async () => {
    const page = async (cursor?: string) => {
      const q = `feed=${ids.aF[0]}&show=all&limit=50${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`;
      return (await (await listGET(new Request(`https://ff.test/api/app/articles?${q}`))).json()) as ArticlePage;
    };
    const before = Date.now();
    const first = await page();
    expect(first.snapshotAt).toBeGreaterThanOrEqual(before);
    expect(first.snapshotAt).toBeLessThanOrEqual(Date.now());
    // Paging never renews the snapshot (only a refetch of the first page does).
    expect((await page(first.nextCursor!)).snapshotAt).toBeUndefined();
    // A backdated arrival INSIDE the loaded span, created after the snapshot.
    await addArticle(ids.alice, ids.aF[0], "r-backdated", "Backdated", (NOW - (NOW - 10.5 * 60_000)) / H, { createdAt: new Date(first.snapshotAt! + 1_000) });
    const result = await markListRangeRead({ listKey: feedKey(), sort: "new", fromId: rows[0], toId: rows[49], maxCreatedAt: first.snapshotAt!, extraIds: [] });
    expect(result.ids).toHaveLength(50);
    expect(await isRead("r-backdated")).toBe(false);
  });

  it("extra ids beyond 1000 (e.g. a big expanded story) are marked whole, counted against the range bound", async () => {
    const result = await markListRangeRead({ listKey: feedKey(), sort: "new", fromId: rows[0], toId: rows[9], maxCreatedAt, extraIds: rows.slice(10, 1200) });
    expect(result.ids).toHaveLength(1200);
    expect(result.undoToken).toEqual(expect.any(String));
    expect(await isRead(rows[1199])).toBe(true);
  });

  it("above the bound (range + extras) nothing changes and the client is told (no silent partial)", async () => {
    const extra = Array.from({ length: MAX_RANGE_IDS - 1200 + 1 }, (_, i) => `rx-${String(i).padStart(5, "0")}`);
    for (let i = 0; i < extra.length; i += 2000) {
      await state.db.article.createMany({
        data: extra.slice(i, i + 2000).map((id) => ({ id, userId: ids.alice, feedId: ids.aF[1], title: id, link: `https://example.test/${id}`, content: "", excerpt: "", publishedAt: new Date(NOW), createdAt: new Date(maxCreatedAt) })),
      });
    }
    const result = await markListRangeRead({ listKey: feedKey(), sort: "new", fromId: rows[0], toId: rows[1199], maxCreatedAt, extraIds: extra });
    expect(result).toEqual({ ids: [], undoToken: null, tooLarge: { limit: MAX_RANGE_IDS } });
    expect(await isRead(rows[0])).toBe(false);
    expect(await isRead(extra[0])).toBe(false);
    // Without a resolvable range the explicit-id fallback refuses above its own bound too.
    const fallback = await markListRangeRead({ listKey: feedKey(), sort: "new", fromId: "gone-a", toId: "gone-b", maxCreatedAt, extraIds: extra.slice(0, 1001) });
    expect(fallback).toEqual({ ids: [], undoToken: null, tooLarge: { limit: 1000 } });
    expect(await isRead(extra[0])).toBe(false);
  }, 60_000);

  it("is user-scoped and validated", async () => {
    state.session = { user: { id: ids.bob } };
    const foreign = await markListRangeRead({ listKey: feedKey(), sort: "new", fromId: rows[0], toId: rows[10], maxCreatedAt, extraIds: [rows[20]] });
    expect(foreign).toEqual({ ids: [], undoToken: null });
    expect(await isRead(rows[0])).toBe(false);
    expect(await isRead(rows[20])).toBe(false);
    state.session = { user: { id: ids.alice } };
    await expect(markListRangeRead({ listKey: "https://evil.test/?feed=x", sort: "new", fromId: "a", toId: "b", maxCreatedAt, extraIds: [] })).rejects.toThrow(/Invalid range/);
    await expect(markListRangeRead({ listKey: "/?feed=a&cat=b", sort: "new", fromId: "a", toId: "b", maxCreatedAt, extraIds: [] })).rejects.toThrow(/Invalid range/);
    await expect(markListRangeRead({ listKey: feedKey(), sort: "new", fromId: "a", toId: "b", maxCreatedAt, extraIds: Array(MAX_RANGE_IDS + 1).fill("x") })).rejects.toThrow(/Invalid range/);
    state.session = null;
    await expect(markListRangeRead({ listKey: feedKey(), sort: "new", fromId: rows[0], toId: rows[1], maxCreatedAt, extraIds: [] })).rejects.toThrow(/Unauthorized/);
  });
});

describe("getClusterDetail visibility (matches the list's 'all feeds' rules)", () => {
  let clusterId = "";
  beforeEach(async () => {
    await resetUser(ids.alice);
    await state.db.feed.updateMany({ where: { userId: ids.alice }, data: { hideFromAllFeeds: false } });
    await addArticle(ids.alice, ids.aF[0], "v-0", EZB[0], 5);
    await addArticle(ids.alice, ids.aF[1], "v-1", EZB[1], 4);
    await addArticle(ids.alice, ids.aF[2], "v-2", EZB[2], 3);
    await clusterUser(ids.alice, { budgetMs: 5_000, now: NOW });
    clusterId = (await state.db.article.findUniqueOrThrow({ where: { id: "v-0" } })).clusterId!;
  });
  afterAll(() => state.db.feed.updateMany({ where: { userId: ids.alice }, data: { hideFromAllFeeds: false } }));

  async function detail() {
    state.session = { user: { id: ids.alice } };
    const res = await clusterGET(new Request(`https://ff.test/api/app/clusters/${clusterId}`), { params: Promise.resolve({ id: clusterId }) });
    return { status: res.status, body: (await res.json()) as ClusterDetail };
  }

  it("members of a feed the user hid from all feeds are not returned and not counted", async () => {
    await state.db.feed.update({ where: { id: ids.aF[1] }, data: { hideFromAllFeeds: true } });
    const { status, body } = await detail();
    expect(status).toBe(200);
    expect(body.members.map((m) => m.id)).toEqual(["v-0", "v-2"]);
    expect(body.size).toBe(2); // visible members, not the stored 3
    expect((await state.db.storyCluster.findUniqueOrThrow({ where: { id: clusterId } })).size).toBe(3);
  });

  it("members of a hidden category and spoilers follow the list rules too", async () => {
    const cat = await state.db.category.create({ data: { name: "Hidden", userId: ids.alice, hideFromAllFeeds: true } });
    await state.db.feed.update({ where: { id: ids.aF[0] }, data: { categoryId: cat.id } });
    await state.db.article.update({ where: { id: "v-2" }, data: { isSpoiler: true } });
    const { body } = await detail();
    expect(body.members.map((m) => m.id)).toEqual(["v-1"]);
    expect(body.size).toBe(1);
    expect(body.members.map((m) => m.id)).toContain(body.leadId); // lead falls back to a visible member
    await state.db.feed.update({ where: { id: ids.aF[0] }, data: { categoryId: null } });
    await state.db.category.delete({ where: { id: cat.id } });
  });

  it("404 when no member is visible any more", async () => {
    await state.db.feed.updateMany({ where: { id: { in: ids.aF.slice(0, 3) } }, data: { hideFromAllFeeds: true } });
    expect((await detail()).status).toBe(404);
  });
});

describe("settings", () => {
  it("defaults to clusterReadMode 'story' (the schema default since the story card, and the fallback for unknown values)", async () => {
    const carol = await state.db.user.create({ data: { email: "carol@test", name: "Carol" } });
    expect(carol.clusterReadMode).toBe("story");
    state.session = { user: { id: carol.id } };
    expect(await getReadingPreferences()).toMatchObject({ clusterReadMode: "story", storyClustering: true });
    await state.db.user.update({ where: { id: carol.id }, data: { clusterReadMode: "bogus" } });
    expect(await getReadingPreferences()).toMatchObject({ clusterReadMode: "story" });
    await state.db.user.update({ where: { id: carol.id }, data: { clusterReadMode: "article" } });
    expect(await getReadingPreferences()).toMatchObject({ clusterReadMode: "article" });
    state.session = { user: { id: ids.alice } };
  });

  it("exposes clusterReadMode and storyClustering, validates writes", async () => {
    await state.db.user.update({ where: { id: ids.alice }, data: { clusterReadMode: "story", storyClustering: true } });
    expect(await getReadingPreferences()).toMatchObject({ clusterReadMode: "story", storyClustering: true });
    await updateGlobalSettings({ clusterReadMode: "article", storyClustering: false });
    expect(await getReadingPreferences()).toMatchObject({ clusterReadMode: "article", storyClustering: false });
    await expect(updateGlobalSettings({ clusterReadMode: "everything" as never })).rejects.toThrow(/clusterReadMode/);
    expect(await getReadingPreferences()).toMatchObject({ clusterReadMode: "article" });
  });
});

describe("markArticleIdsRead (row menu: \"Alles bis hier als gelesen\")", () => {
  it("marks exactly the user's own unread ids, returns them with an undo token, and undo restores them", async () => {
    await resetUser(ids.alice);
    await resetUser(ids.bob);
    await addArticle(ids.alice, ids.aF[0], "up-1", "One", 1);
    await addArticle(ids.alice, ids.aF[0], "up-2", "Two", 2);
    await addArticle(ids.alice, ids.aF[0], "up-3", "Three", 3, { isRead: true, readAt: new Date(NOW - 9 * H) });
    await addArticle(ids.bob, ids.bF[0], "up-bob", "Bob's", 1);
    const result = await markArticleIdsRead(["up-1", "up-2", "up-3", "up-bob", "missing"]);
    expect(result.ids.sort()).toEqual(["up-1", "up-2"]);
    expect(result.undoToken).toEqual(expect.any(String));
    const flags = async (id: string) => (await state.db.article.findUniqueOrThrow({ where: { id } })).isRead;
    expect(await flags("up-1")).toBe(true);
    expect(await flags("up-bob")).toBe(false);
    // The already-read row keeps its original readAt.
    expect((await state.db.article.findUniqueOrThrow({ where: { id: "up-3" } })).readAt?.getTime()).toBe(NOW - 9 * H);
    const undone = await markArticlesAsUnread(result.undoToken!);
    expect(undone.ids.sort()).toEqual(["up-1", "up-2"]);
    expect(await flags("up-1")).toBe(false);
    expect(await flags("up-3")).toBe(true);
  });

  it("rejects invalid input and requires a session", async () => {
    await expect(markArticleIdsRead([])).rejects.toThrow(/Invalid ids/);
    await expect(markArticleIdsRead("up-1")).rejects.toThrow(/Invalid ids/);
    state.session = null;
    await expect(markArticleIdsRead(["up-1"])).rejects.toThrow(/Unauthorized/);
  });

  it("returns no undo token when nothing changed", async () => {
    await resetUser(ids.alice);
    await addArticle(ids.alice, ids.aF[0], "up-r", "Read", 1, { isRead: true });
    expect(await markArticleIdsRead(["up-r"])).toEqual({ ids: [], undoToken: null });
  });
});
