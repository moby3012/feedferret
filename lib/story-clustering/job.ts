import { randomBytes } from "node:crypto";
import { performance } from "node:perf_hooks";
import { db } from "../db";
import { logger } from "../logger";
import { ClusterEngine, betterLead } from "./engine";
import { computeStorySig, parseSig, serializeSig } from "./normalize";
import { CONFIG } from "./similarity";
import type { ClusterDecision, ClusterSig, ClusterState, PendingItem, StorySig, WindowItem } from "./types";

// DB side of story clustering (K1): bounded, batched, idempotent. Each tick
// claims pending articles (`clusteredAt IS NULL`, published in the last 48 h),
// runs the pure engine and writes cluster rows + claims. A claim is an
// `updateMany` conditional on `clusteredAt: null`, so a concurrent instance or
// a re-run never double-processes a row. Never throws into the caller.
//
// `Article.updatedAt` is the GReader `ot`/`updated` modification clock and
// clustering metadata is not a content change, so every article write here
// goes through `touchlessUpdate`: it writes `updatedAt` back unchanged, guarded
// by the value it just read (same pattern as lib/article-meta-backfill.ts —
// works on SQLite and Postgres, no raw SQL).

/** Pending articles read per user per round; also the engine's step granularity upper bound. */
export const PENDING_BATCH = 200;
/** Decisions processed (and written) between two yields / budget checks. */
export const STEP_SIZE = 50;
/**
 * Upper bound of window rows loaded per user (spec: ≤ 5k). Newest rows win; when
 * a user has more processed articles in 48 h, the oldest ones are not candidates
 * for joins (recall trade-off, see docs/story-clustering.md).
 */
const WINDOW_LIMIT = 6000;
/** Pending rows older than the window settled per query (they can never cluster). */
const STALE_BATCH = 500;
/** Attempts to write a row whose `updatedAt` moved between read and write. */
const TOUCHLESS_ATTEMPTS = 4;
const WRITE_CHUNK = 100;
const CLUSTER_ALGO_VERSION = 1;
const CLUSTER_RETENTION_MS = 14 * 24 * 3_600_000;

const GLOBAL_KEY = "__feedferret_story_clustering__";
type JobState = { running: boolean; rotate: number };
function getState(): JobState {
  const g = globalThis as unknown as Record<string, JobState>;
  return (g[GLOBAL_KEY] ??= { running: false, rotate: 0 });
}

export function isStoryClusteringDisabled(): boolean {
  return process.env.DISABLE_STORY_CLUSTERING === "true";
}

const yieldToLoop = () => new Promise<void>((resolve) => setImmediate(resolve));
const newClusterId = () => `sc${randomBytes(12).toString("base64url")}`;

export interface ClusterRunOptions {
  /** Wall budget in ms for the whole run (checked between steps). */
  budgetMs: number;
  /** Epoch ms; default Date.now(). Injected by tests. */
  now?: number;
}

type TouchlessItem = { id: string; data: Record<string, unknown> };

/** In-memory check of the `extraWhere` equality filters used by touchlessUpdate (null / scalar). */
function matchesExtraWhere(row: Record<string, unknown>, extraWhere: Record<string, unknown>): boolean {
  return Object.entries(extraWhere).every(([key, value]) => row[key] === value);
}

/**
 * `updateMany` per row that leaves `Article.updatedAt` untouched: reads the
 * current value, writes `data` plus that same `updatedAt` with `updatedAt` in
 * the `where` guard. A row that changed in between (read toggle, sync) is
 * re-read and retried; a row that no longer matches `extraWhere` (or vanished)
 * is dropped. Returns the ids actually written.
 */
async function touchlessUpdate(userId: string, items: TouchlessItem[], extraWhere: Record<string, unknown>): Promise<Set<string>> {
  const done = new Set<string>();
  let open = items;
  for (let attempt = 0; attempt < TOUCHLESS_ATTEMPTS && open.length > 0; attempt++) {
    const stamps = new Map<string, Date>();
    for (let i = 0; i < open.length; i += 500) {
      // Looked up by primary key only and filtered in memory: with `userId` + `clusterId IS NULL` in
      // the WHERE, SQLite picks the (userId, clusterId) index — a scan over most of the user's
      // articles (35–40 ms per call at 50 k rows) — instead of a handful of PK lookups.
      const rows = await db.article.findMany({
        where: { id: { in: open.slice(i, i + 500).map((o) => o.id) } },
        select: { id: true, updatedAt: true, userId: true, clusterId: true, clusteredAt: true },
      });
      for (const r of rows) {
        if (r.userId === userId && matchesExtraWhere(r, extraWhere)) stamps.set(r.id, r.updatedAt);
      }
    }
    const writable = open.filter((o) => stamps.has(o.id));
    const retry: TouchlessItem[] = [];
    for (let i = 0; i < writable.length; i += WRITE_CHUNK) {
      const chunk = writable.slice(i, i + WRITE_CHUNK);
      const counts = await db.$transaction(
        chunk.map((o) =>
          db.article.updateMany({
            where: { ...extraWhere, id: o.id, userId, updatedAt: stamps.get(o.id)! },
            data: { ...o.data, updatedAt: stamps.get(o.id)! },
          }),
        ),
      );
      counts.forEach((c, k) => (c.count > 0 ? done.add(chunk[k].id) : retry.push(chunk[k])));
    }
    open = retry;
  }
  return done;
}

export interface UserRunResult {
  processed: number;
  joined: number;
  created: number;
  singles: number;
  skipped: number;
  /** Pending articles of this user that were not reached (budget) or exceed the batch. */
  morePending: boolean;
  /** Pending rows older than the window that were settled without a cluster. */
  expired?: number;
  ms: number;
}

const emptyResult = (): UserRunResult => ({ processed: 0, joined: 0, created: 0, singles: 0, skipped: 0, morePending: false, ms: 0 });

type PendingRow = {
  id: string;
  feedId: string;
  publishedAt: Date;
  storySig: string | null;
  title: string;
  excerpt: string | null;
  link: string;
  imageUrl: string | null;
  readMinutes: number | null;
  isDuplicate: boolean;
  feed: { name: string; priority: string } | null;
};

/**
 * Marks pending rows older than the window as processed (no cluster): nothing
 * can join them any more, and they must not stay pending forever. Bounded per
 * call; returns whether more are left.
 */
async function settleExpiredPending(userId: string, windowStart: Date, now: number, deadline: number): Promise<{ settled: number; more: boolean }> {
  let settled = 0;
  for (;;) {
    const rows = await db.article.findMany({
      where: { userId, clusteredAt: null, publishedAt: { lt: windowStart } },
      select: { id: true },
      take: STALE_BATCH,
    });
    if (rows.length === 0) return { settled, more: false };
    const done = await touchlessUpdate(userId, rows.map((r) => ({ id: r.id, data: { clusteredAt: new Date(now) } })), { clusteredAt: null });
    settled += done.size;
    if (done.size === 0) return { settled, more: false }; // nothing writable (concurrent changes): next tick
    if (rows.length < STALE_BATCH) return { settled, more: false };
    if (performance.now() >= deadline) return { settled, more: true };
  }
}

/**
 * Clusters one user's pending articles inside `deadline` (performance.now()
 * based). Window load and engine build count against the deadline: unless
 * `mustProgress` (default true; the multi-user run sets it only for the first
 * user), a spent budget returns before the heavy part.
 */
export async function clusterUser(userId: string, opts: ClusterRunOptions & { deadline?: number; mustProgress?: boolean }): Promise<UserRunResult> {
  const started = performance.now();
  const deadline = opts.deadline ?? started + opts.budgetMs;
  const mustProgress = opts.mustProgress ?? true;
  const now = opts.now ?? Date.now();
  const windowStart = new Date(now - CONFIG.windowMs);
  const result = emptyResult();

  const expired = await settleExpiredPending(userId, windowStart, now, deadline);
  if (expired.settled > 0) result.expired = expired.settled;
  if (expired.more) result.morePending = true;

  const pendingRows = (await db.article.findMany({
    where: { userId, clusteredAt: null, publishedAt: { gte: windowStart } },
    orderBy: [{ publishedAt: "asc" }, { id: "asc" }],
    take: PENDING_BATCH + 1,
    select: {
      id: true,
      feedId: true,
      publishedAt: true,
      storySig: true,
      title: true,
      excerpt: true,
      link: true,
      imageUrl: true,
      readMinutes: true,
      isDuplicate: true,
      feed: { select: { name: true, priority: true } },
    },
  })) as PendingRow[];
  if (pendingRows.length === 0) {
    result.ms = performance.now() - started;
    return result;
  }
  if (!mustProgress && performance.now() >= deadline) {
    result.morePending = true;
    result.ms = performance.now() - started;
    return result;
  }
  result.morePending ||= pendingRows.length > PENDING_BATCH;
  const batch = pendingRows.slice(0, PENDING_BATCH);

  // Signatures: parse stored ones, compute the missing ones (pre-K1 rows) — only
  // those need their body (outbound links), read in one extra query.
  const missing = batch.filter((r) => !parseSig(r.storySig)).map((r) => r.id);
  const bodies = new Map<string, string>();
  if (missing.length > 0) {
    // PK lookup + in-memory user check (see touchlessUpdate: a `userId` predicate steers SQLite to a scan).
    const rows = await db.article.findMany({ where: { id: { in: missing } }, select: { id: true, content: true, userId: true } });
    for (const r of rows) if (r.userId === userId) bodies.set(r.id, r.content);
  }
  const pending: PendingItem[] = [];
  const freshSigs = new Map<string, string>(); // id → serialized sig to persist with the claim
  for (const row of batch) {
    let sig = parseSig(row.storySig);
    if (!sig) {
      sig = computeStorySig({
        title: row.title,
        excerpt: row.excerpt,
        content: bodies.get(row.id) ?? null,
        link: row.link,
        feedName: row.feed?.name ?? null,
        feedPriority: row.feed?.priority ?? null,
        imageUrl: row.imageUrl,
        readMinutes: row.readMinutes,
        isDuplicate: row.isDuplicate,
      });
      freshSigs.set(row.id, serializeSig(sig));
    }
    pending.push({ id: row.id, feedId: row.feedId, publishedAt: row.publishedAt.getTime(), sig });
  }

  // Window = processed articles of the last 48 h (clustered members and singletons).
  const [windowRows, clusterRows] = await Promise.all([
    db.article.findMany({
      where: { userId, publishedAt: { gte: windowStart }, clusteredAt: { not: null }, storySig: { not: null } },
      orderBy: { publishedAt: "desc" },
      take: WINDOW_LIMIT,
      select: { id: true, feedId: true, publishedAt: true, clusterId: true, storySig: true },
    }),
    db.storyCluster.findMany({
      where: { userId, lastSeenAt: { gte: windowStart } },
      select: { id: true, leadArticleId: true, size: true, firstSeenAt: true, lastSeenAt: true, sig: true, articles: { select: { feedId: true } } },
    }),
  ]);
  if (!mustProgress && performance.now() >= deadline) {
    result.morePending = true;
    result.ms = performance.now() - started;
    return result;
  }
  const windowItems: WindowItem[] = [];
  for (const r of windowRows) {
    const sig = parseSig(r.storySig);
    if (sig) windowItems.push({ id: r.id, feedId: r.feedId, publishedAt: r.publishedAt.getTime(), clusterId: r.clusterId, sig });
  }
  const clusters: ClusterState[] = [];
  for (const c of clusterRows) {
    let sig: ClusterSig;
    try {
      sig = JSON.parse(c.sig) as ClusterSig;
    } catch {
      continue;
    }
    clusters.push({
      id: c.id,
      leadArticleId: c.leadArticleId,
      size: c.size,
      feedIds: [...new Set(c.articles.map((a) => a.feedId))],
      firstSeenAt: c.firstSeenAt.getTime(),
      lastSeenAt: c.lastSeenAt.getTime(),
      sig,
    });
  }

  const engine = new ClusterEngine(pending, windowItems, clusters, { newClusterId });
  const pendingById = new Map(pending.map((p) => [p.id, p]));

  while (engine.remaining > 0) {
    const decisions = engine.step(STEP_SIZE);
    const touched = engine.drainTouched();
    await writeStep(userId, decisions, touched, pendingById, freshSigs, now);
    for (const d of decisions) {
      result.processed++;
      if (d.action === "join") result.joined++;
      else if (d.action === "create") result.created++;
      else if (d.action === "single") result.singles++;
      else result.skipped++;
    }
    await yieldToLoop();
    if (engine.remaining > 0 && performance.now() >= deadline) {
      result.morePending = true;
      break;
    }
  }
  result.ms = performance.now() - started;
  return result;
}

async function writeStep(
  userId: string,
  decisions: ClusterDecision[],
  touched: ClusterState[],
  pendingById: Map<string, PendingItem>,
  freshSigs: Map<string, string>,
  now: number,
): Promise<void> {
  const claimedAt = new Date(now);
  const sigData = (id: string) => {
    const fresh = freshSigs.get(id) ?? (pendingById.has(id) ? serializeSig(pendingById.get(id)!.sig) : undefined);
    return fresh === undefined ? {} : { storySig: fresh };
  };

  // 1) clusters first (articles reference them).
  const createdIds = new Set(decisions.filter((d) => d.action === "create").map((d) => d.clusterId!));
  const clusterOps = touched.map((c) => {
    const data = {
      leadArticleId: c.leadArticleId,
      size: c.size,
      feedCount: new Set(c.feedIds).size,
      firstSeenAt: new Date(c.firstSeenAt),
      lastSeenAt: new Date(c.lastSeenAt),
      sig: serializeClusterSig(c.sig),
      algoVersion: CLUSTER_ALGO_VERSION,
    };
    return createdIds.has(c.id)
      ? db.storyCluster.create({ data: { id: c.id, userId, ...data } })
      : db.storyCluster.updateMany({ where: { id: c.id, userId }, data });
  });
  for (let i = 0; i < clusterOps.length; i += WRITE_CHUNK) await db.$transaction(clusterOps.slice(i, i + WRITE_CHUNK));

  // 2) claims (`clusteredAt: null` keeps each write idempotent / multi-instance safe) and the
  // singleton partners of new clusters (`clusterId: null`). Neither moves `updatedAt`.
  const claims: TouchlessItem[] = [];
  const partners: TouchlessItem[] = [];
  const clusterOfClaim = new Map<string, string>();
  const clusterOfPartner = new Map<string, string>();
  for (const d of decisions) {
    claims.push({ id: d.articleId, data: { clusteredAt: claimedAt, clusterId: d.clusterId ?? null, ...sigData(d.articleId) } });
    if (d.clusterId) clusterOfClaim.set(d.articleId, d.clusterId);
    if (d.action === "create" && d.partnerId) {
      partners.push({ id: d.partnerId, data: { clusterId: d.clusterId } });
      clusterOfPartner.set(d.partnerId, d.clusterId!);
    }
  }
  const claimed = await touchlessUpdate(userId, claims, { clusteredAt: null });
  const partnered = await touchlessUpdate(userId, partners, { clusterId: null });

  // Lost a claim or a partner to another instance (or a deleted row) → recount the touched
  // cluster from the DB instead of trusting the in-memory size: a 1-member cluster is dissolved.
  const failedClusters = new Set<string>();
  for (const [id, clusterId] of clusterOfClaim) if (!claimed.has(id)) failedClusters.add(clusterId);
  for (const [id, clusterId] of clusterOfPartner) if (!partnered.has(id)) failedClusters.add(clusterId);
  for (const clusterId of failedClusters) await reconcileCluster(userId, clusterId);
}

/** JSON for `StoryCluster.sig`, kept ≤ 2 KB: anchor entities, then the anchor itself, are dropped first. */
export function serializeClusterSig(sig: ClusterSig): string {
  let json = JSON.stringify(sig);
  if (json.length <= 2048 || !sig.anchor) return json;
  json = JSON.stringify({ ...sig, anchor: sig.anchor.map((a) => ({ ...a, e: [] })) });
  if (json.length <= 2048) return json;
  const { anchor: _anchor, ...rest } = sig;
  return JSON.stringify(rest);
}

/**
 * Recounts one cluster from its members and repairs it: < 2 members → dissolved
 * (remaining member's `clusterId` cleared, row deleted); otherwise size,
 * feedCount, time span and a dangling `leadArticleId` (member deleted or moved)
 * are fixed, re-picking the lead with the engine's rule.
 */
export async function reconcileCluster(userId: string, clusterId: string): Promise<"dissolved" | "repaired" | "ok" | "missing"> {
  const cluster = await db.storyCluster.findFirst({ where: { id: clusterId, userId } });
  if (!cluster) return "missing";
  const members = await db.article.findMany({
    where: { userId, clusterId },
    select: { id: true, feedId: true, publishedAt: true, storySig: true },
  });
  if (members.length < 2) {
    await touchlessUpdate(userId, members.map((m) => ({ id: m.id, data: { clusterId: null } })), { clusterId });
    await db.storyCluster.deleteMany({ where: { id: clusterId, userId } });
    return "dissolved";
  }
  const data: Record<string, unknown> = {};
  if (cluster.size !== members.length) data.size = members.length;
  const feedCount = new Set(members.map((m) => m.feedId)).size;
  if (cluster.feedCount !== feedCount) data.feedCount = feedCount;
  const first = Math.min(...members.map((m) => m.publishedAt.getTime()));
  const last = Math.max(...members.map((m) => m.publishedAt.getTime()));
  if (cluster.firstSeenAt.getTime() !== first) data.firstSeenAt = new Date(first);
  if (cluster.lastSeenAt.getTime() !== last) data.lastSeenAt = new Date(last);
  if (!members.some((m) => m.id === cluster.leadArticleId)) {
    let best = members[0];
    let bestSig = parseSig(best.storySig);
    for (const m of members.slice(1)) {
      const sig = parseSig(m.storySig);
      if (betterLead({ q: sig?.q ?? 0, t: m.publishedAt.getTime(), id: m.id }, { q: bestSig?.q ?? 0, t: best.publishedAt.getTime(), id: best.id })) {
        best = m;
        bestSig = sig;
      }
    }
    data.leadArticleId = best.id;
    let sig: ClusterSig | null = null;
    try {
      sig = JSON.parse(cluster.sig) as ClusterSig;
    } catch {
      sig = null;
    }
    if (bestSig) data.sig = serializeClusterSig({ t: sig?.t ?? {}, e: sig?.e ?? [], lead: bestSig, ...(sig?.anchor ? { anchor: sig.anchor } : {}) });
  }
  if (Object.keys(data).length === 0) return "ok";
  await db.storyCluster.updateMany({ where: { id: clusterId, userId }, data });
  return "repaired";
}

export interface RunResult extends UserRunResult {
  users: number;
  disabled?: boolean;
}

/**
 * One bounded pass over all users with story clustering on. Round-robin start
 * so one busy user cannot starve the others. Resolves with stats; never rejects.
 */
export async function runStoryClustering(opts: ClusterRunOptions): Promise<RunResult> {
  const total: RunResult = { ...emptyResult(), users: 0 };
  if (isStoryClusteringDisabled()) return { ...total, disabled: true };
  const state = getState();
  if (state.running) return { ...total, morePending: true };
  state.running = true;
  const started = performance.now();
  const deadline = started + opts.budgetMs;
  try {
    // Only users with pending rows: an idle user costs nothing per tick.
    const users = await db.user.findMany({
      where: { storyClustering: true, isActive: true, articles: { some: { clusteredAt: null } } },
      select: { id: true },
      orderBy: { id: "asc" },
    });
    if (users.length === 0) return total;
    const start = state.rotate % users.length;
    state.rotate = (state.rotate + 1) % users.length;
    for (let i = 0; i < users.length; i++) {
      // The first user always gets a step (progress under any budget); later users only while budget is left.
      if (i > 0 && performance.now() >= deadline) {
        total.morePending = true;
        break;
      }
      const user = users[(start + i) % users.length];
      try {
        const r = await clusterUser(user.id, { ...opts, deadline, mustProgress: i === 0 });
        total.users++;
        total.processed += r.processed;
        total.joined += r.joined;
        total.created += r.created;
        total.singles += r.singles;
        total.skipped += r.skipped;
        total.expired = (total.expired ?? 0) + (r.expired ?? 0);
        total.morePending ||= r.morePending;
      } catch (error) {
        logger.error(`[story-clustering] user ${user.id} failed:`, error);
      }
    }
  } catch (error) {
    logger.error("[story-clustering] run failed:", error);
  } finally {
    state.running = false;
    total.ms = performance.now() - started;
  }
  return total;
}

const DRAIN_KEY = "__feedferret_story_clustering_drain__";

/**
 * Runs `runStoryClustering` repeatedly (each pass ≤ budget, a timer gap in
 * between) until nothing is pending — the first-run 48 h backfill and big
 * sync bursts. Single-flight; fire and forget.
 */
export function drainStoryClustering(budgetMs = 400, maxPasses = 100, gapMs = 1500): void {
  if (isStoryClusteringDisabled()) return;
  const g = globalThis as unknown as Record<string, boolean>;
  if (g[DRAIN_KEY]) return;
  g[DRAIN_KEY] = true;
  let pass = 0;
  const next = async () => {
    try {
      const r = await runStoryClustering({ budgetMs });
      pass++;
      if (r.morePending && pass < maxPasses) {
        const t = setTimeout(() => void next(), gapMs);
        t.unref?.();
        return;
      }
    } catch (error) {
      logger.error("[story-clustering] drain failed:", error);
    }
    g[DRAIN_KEY] = false;
  };
  void next();
}

const CLEANUP_PAGE = 200;

export interface CleanupResult {
  /** Clusters removed: stale (> 14 d), memberless, or dissolved (< 2 members left). */
  deleted: number;
  /** Clusters whose size / feedCount / span / lead was corrected. */
  repaired: number;
}

/**
 * Daily housekeeping (called next to the retention run): drops clusters older
 * than 14 d or without members, then recounts the rest — members removed by
 * retention, user deletes or the duplicate pass leave stale `size`s, 1-member
 * clusters and dangling `leadArticleId`s behind. Takes the job's in-process
 * lock so it never interleaves with a clustering pass.
 */
export async function cleanupStoryClusters(now = Date.now()): Promise<CleanupResult> {
  const result: CleanupResult = { deleted: 0, repaired: 0 };
  if (isStoryClusteringDisabled()) return result;
  const state = getState();
  for (let i = 0; state.running && i < 20; i++) await new Promise((resolve) => setTimeout(resolve, 250));
  if (state.running) return result; // a long pass is still running: try again tomorrow
  state.running = true;
  try {
    const stale = await db.storyCluster.deleteMany({ where: { lastSeenAt: { lt: new Date(now - CLUSTER_RETENTION_MS) } } });
    const empty = await db.storyCluster.deleteMany({ where: { articles: { none: {} } } });
    result.deleted = stale.count + empty.count;

    let cursor: string | undefined;
    for (;;) {
      const page = await db.storyCluster.findMany({
        orderBy: { id: "asc" },
        take: CLEANUP_PAGE,
        ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
        select: { id: true, userId: true, size: true, leadArticleId: true },
      });
      if (page.length === 0) break;
      cursor = page[page.length - 1].id;
      const ids = page.map((c) => c.id);
      const [counts, leads] = await Promise.all([
        db.article.groupBy({ by: ["clusterId"], where: { clusterId: { in: ids } }, _count: { _all: true } }),
        db.article.findMany({ where: { id: { in: page.map((c) => c.leadArticleId) }, clusterId: { in: ids } }, select: { id: true, clusterId: true } }),
      ]);
      const countOf = new Map(counts.map((c) => [c.clusterId, c._count._all]));
      const leadCluster = new Map(leads.map((l) => [l.id, l.clusterId]));
      for (const c of page) {
        const n = countOf.get(c.id) ?? 0;
        if (n === c.size && n >= 2 && leadCluster.get(c.leadArticleId) === c.id) continue;
        const outcome = await reconcileCluster(c.userId, c.id);
        if (outcome === "dissolved") result.deleted++;
        else if (outcome === "repaired") result.repaired++;
      }
      if (page.length < CLEANUP_PAGE) break;
    }
  } finally {
    state.running = false;
  }
  return result;
}

export type { StorySig };
