import { randomBytes } from "node:crypto";
import { performance } from "node:perf_hooks";
import { db } from "../db";
import { logger } from "../logger";
import { ClusterEngine } from "./engine";
import { computeStorySig, parseSig, serializeSig } from "./normalize";
import { CONFIG } from "./similarity";
import type { ClusterDecision, ClusterSig, ClusterState, PendingItem, StorySig, WindowItem } from "./types";

// DB side of story clustering (K1): bounded, batched, idempotent. Each tick
// claims pending articles (`clusteredAt IS NULL`, published in the last 48 h),
// runs the pure engine and writes cluster rows + claims. A claim is an
// `updateMany` conditional on `clusteredAt: null`, so a concurrent instance or
// a re-run never double-processes a row. Never throws into the caller.

/** Pending articles read per user per round; also the engine's step granularity upper bound. */
export const PENDING_BATCH = 200;
/** Decisions processed (and written) between two yields / budget checks. */
export const STEP_SIZE = 50;
/** Upper bound of window rows loaded per user (spec: ≤ 5k). */
const WINDOW_LIMIT = 6000;
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

export interface UserRunResult {
  processed: number;
  joined: number;
  created: number;
  singles: number;
  skipped: number;
  /** Pending articles of this user that were not reached (budget) or exceed the batch. */
  morePending: boolean;
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

/** Clusters one user's pending articles inside `deadline` (performance.now() based). */
export async function clusterUser(userId: string, opts: ClusterRunOptions & { deadline?: number }): Promise<UserRunResult> {
  const started = performance.now();
  const deadline = opts.deadline ?? started + opts.budgetMs;
  const now = opts.now ?? Date.now();
  const windowStart = new Date(now - CONFIG.windowMs);
  const result = emptyResult();

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
  result.morePending = pendingRows.length > PENDING_BATCH;
  const batch = pendingRows.slice(0, PENDING_BATCH);

  // Signatures: parse stored ones, compute the missing ones (pre-K1 rows) — only
  // those need their body (outbound links), read in one extra query.
  const missing = batch.filter((r) => !parseSig(r.storySig)).map((r) => r.id);
  const bodies = new Map<string, string>();
  if (missing.length > 0) {
    const rows = await db.article.findMany({ where: { userId, id: { in: missing } }, select: { id: true, content: true } });
    for (const r of rows) bodies.set(r.id, r.content);
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
      sig: JSON.stringify(c.sig),
      algoVersion: CLUSTER_ALGO_VERSION,
    };
    return createdIds.has(c.id)
      ? db.storyCluster.create({ data: { id: c.id, userId, ...data } })
      : db.storyCluster.updateMany({ where: { id: c.id, userId }, data });
  });
  for (let i = 0; i < clusterOps.length; i += WRITE_CHUNK) await db.$transaction(clusterOps.slice(i, i + WRITE_CHUNK));

  // 2) claims. `clusteredAt: null` makes each write idempotent / multi-instance safe.
  const articleOps: ReturnType<typeof db.article.updateMany>[] = [];
  const opMeta: Array<{ clusterId?: string; articleId: string }> = [];
  for (const d of decisions) {
    articleOps.push(
      db.article.updateMany({
        where: { id: d.articleId, userId, clusteredAt: null },
        data: { clusteredAt: claimedAt, clusterId: d.clusterId ?? null, ...sigData(d.articleId) },
      }),
    );
    opMeta.push({ clusterId: d.clusterId, articleId: d.articleId });
    if (d.action === "create" && d.partnerId) {
      articleOps.push(db.article.updateMany({ where: { id: d.partnerId, userId, clusterId: null }, data: { clusterId: d.clusterId } }));
      opMeta.push({ articleId: d.partnerId });
    }
  }
  const failedClusters = new Set<string>();
  for (let i = 0; i < articleOps.length; i += WRITE_CHUNK) {
    const counts = await db.$transaction(articleOps.slice(i, i + WRITE_CHUNK));
    counts.forEach((c, k) => {
      const meta = opMeta[i + k];
      if (c.count === 0 && meta.clusterId) failedClusters.add(meta.clusterId);
    });
  }

  // Lost a claim to another instance → recount the touched cluster from the DB.
  for (const clusterId of failedClusters) {
    const memberCount = await db.article.count({ where: { userId, clusterId } });
    if (memberCount < 2) {
      await db.article.updateMany({ where: { userId, clusterId }, data: { clusterId: null } });
      await db.storyCluster.deleteMany({ where: { id: clusterId, userId } });
    } else {
      await db.storyCluster.updateMany({ where: { id: clusterId, userId }, data: { size: memberCount } });
    }
  }
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
    const users = await db.user.findMany({ where: { storyClustering: true, isActive: true }, select: { id: true }, orderBy: { id: "asc" } });
    if (users.length === 0) return total;
    const start = state.rotate % users.length;
    state.rotate = (state.rotate + 1) % users.length;
    for (let i = 0; i < users.length; i++) {
      if (performance.now() >= deadline) {
        total.morePending = true;
        break;
      }
      const user = users[(start + i) % users.length];
      try {
        const r = await clusterUser(user.id, { ...opts, deadline });
        total.users++;
        total.processed += r.processed;
        total.joined += r.joined;
        total.created += r.created;
        total.singles += r.singles;
        total.skipped += r.skipped;
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

/** Daily housekeeping (called next to the retention run): stale or memberless clusters. */
export async function cleanupStoryClusters(now = Date.now()): Promise<{ deleted: number }> {
  if (isStoryClusteringDisabled()) return { deleted: 0 };
  const stale = await db.storyCluster.deleteMany({ where: { lastSeenAt: { lt: new Date(now - CLUSTER_RETENTION_MS) } } });
  const empty = await db.storyCluster.deleteMany({ where: { articles: { none: {} } } });
  return { deleted: stale.count + empty.count };
}

export type { StorySig };
