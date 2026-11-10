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
import { clusterUser, cleanupStoryClusters, runStoryClustering, PENDING_BATCH, STEP_SIZE } from "../../lib/story-clustering/job";
import { applyArticleStateOps } from "../../server/articles/state";
import { getReadingPreferences, updateGlobalSettings } from "../../app/actions/settings";
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
    expect(r).toMatchObject({ processed: 4, created: 1, joined: 1, singles: 2, morePending: false });
    const rows = await state.db.article.findMany({ where: { userId: ids.alice }, orderBy: { id: "asc" } });
    const ezb = rows.filter((a) => a.id.startsWith("a-ezb"));
    expect(new Set(ezb.map((a) => a.clusterId)).size).toBe(1);
    expect(ezb[0].clusterId).toBeTruthy();
    const other = rows.find((a) => a.id === "a-other")!;
    expect(other.clusterId).toBeNull();
    expect(other.clusteredAt).not.toBeNull(); // processed singleton
    expect(other.storySig).toContain('"v":1');
    const old = rows.find((a) => a.id === "a-old")!;
    expect(old.clusteredAt).toBeNull(); // never touched
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

  it("cleanup removes stale and memberless clusters only", async () => {
    await resetUser(ids.alice);
    const mk = (id: string, daysAgo: number) =>
      state.db.storyCluster.create({
        data: { id, userId: ids.alice, leadArticleId: "x", size: 2, feedCount: 2, firstSeenAt: new Date(NOW), lastSeenAt: new Date(NOW - daysAgo * 24 * H), sig: "{}" },
      });
    await mk("keep", 1);
    await mk("stale", 20);
    await mk("empty", 1);
    await addArticle(ids.alice, ids.aF[0], "k-0", "x y z", 1, { clusterId: "keep" });
    await addArticle(ids.alice, ids.aF[1], "k-1", "x y z", 1, { clusterId: "stale" });
    const r = await cleanupStoryClusters(NOW);
    expect(r.deleted).toBe(2);
    expect((await state.db.storyCluster.findMany({ where: { userId: ids.alice } })).map((c) => c.id)).toEqual(["keep"]);
    expect((await state.db.article.findUniqueOrThrow({ where: { id: "k-1" } })).clusterId).toBeNull(); // SetNull
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

  it("is user-scoped: another user's lead id cascades nothing and is reported failed", async () => {
    const res = await applyArticleStateOps(ids.bob, [{ id: lead, isRead: true }]);
    expect(res).toEqual({ failed: [lead], affected: [] });
    for (const id of ["s-0", "s-1", "s-2"]) expect(await isRead(id)).toBe(false);
  });
});

describe("settings", () => {
  it("exposes clusterReadMode (default 'story') and storyClustering, validates writes", async () => {
    await state.db.user.update({ where: { id: ids.alice }, data: { clusterReadMode: "story", storyClustering: true } });
    expect(await getReadingPreferences()).toMatchObject({ clusterReadMode: "story", storyClustering: true });
    await updateGlobalSettings({ clusterReadMode: "article", storyClustering: false });
    expect(await getReadingPreferences()).toMatchObject({ clusterReadMode: "article", storyClustering: false });
    await expect(updateGlobalSettings({ clusterReadMode: "everything" as never })).rejects.toThrow(/clusterReadMode/);
    expect(await getReadingPreferences()).toMatchObject({ clusterReadMode: "article" });
  });
});
