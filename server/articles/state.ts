import { z } from "zod";
import { db } from "@/lib/db";
import { setReadStateByIds } from "./bulk-read";

// Batched article state writes (.pm/spec-shell-design.md §2.4): the client's
// state batcher sends every read / star / read-later toggle of one flush as a
// single call. Each op sets one or more boolean fields of one article.

export const STATE_FIELDS = ["isRead", "isStarred", "isReadLater"] as const;
export type StateField = (typeof STATE_FIELDS)[number];

export interface ArticleStateOp {
  id: string;
  isRead?: boolean;
  isStarred?: boolean;
  isReadLater?: boolean;
  /**
   * With `isRead: true`: this article stands for its whole story (the story
   * card in the list, which shows a non-lead source when the lead is not
   * loaded) — cascade to its cluster even though it is not the lead.
   */
  story?: boolean;
}

/** Story cascade result of one originating op: the cluster's other sources it marked read. */
export interface StoryCascade {
  /** The op's article id (the lead, or the source a story card stood for). */
  origin: string;
  clusterId: string;
  ids: string[];
}

/** Upper bound of members one batch may mark read through story cascading (clusters are capped at 50 sources). */
export const MAX_CASCADE_MEMBERS = 500;

/** Upper bound of ops per call. The batcher flushes at least every second, so a real client stays far below. */
export const MAX_STATE_OPS = 200;
export const MAX_ID_LENGTH = 128;

const OpSchema = z
  .object({
    id: z.string().min(1).max(MAX_ID_LENGTH),
    isRead: z.boolean().optional(),
    isStarred: z.boolean().optional(),
    isReadLater: z.boolean().optional(),
    story: z.boolean().optional(),
  })
  .strict()
  .refine((op) => STATE_FIELDS.some((f) => op[f] !== undefined), { message: "Op sets no field" });

const OpsSchema = z.array(OpSchema).min(1).max(MAX_STATE_OPS);

export type ParsedStateOps = { ok: true; ops: ArticleStateOp[] } | { ok: false; error: string };

export function parseStateOps(input: unknown): ParsedStateOps {
  const parsed = OpsSchema.safeParse(input);
  if (!parsed.success) return { ok: false, error: parsed.error.issues[0]?.message ?? "Invalid ops" };
  return { ok: true, ops: parsed.data };
}

/**
 * Merges ops per article (later ops win per field) and groups them into one
 * update per (field, value). Exported for tests.
 */
export function groupStateOps(ops: ArticleStateOp[]): Map<`${StateField}:${boolean}`, string[]> {
  const byId = new Map<string, Partial<Record<StateField, boolean>>>();
  for (const op of ops) {
    const merged = byId.get(op.id) ?? {};
    for (const field of STATE_FIELDS) if (op[field] !== undefined) merged[field] = op[field];
    byId.set(op.id, merged);
  }
  const groups = new Map<`${StateField}:${boolean}`, string[]>();
  for (const [id, fields] of byId) {
    for (const field of STATE_FIELDS) {
      const value = fields[field];
      if (value === undefined) continue;
      const key = `${field}:${value}` as const;
      const ids = groups.get(key) ?? [];
      ids.push(id);
      groups.set(key, ids);
    }
  }
  return groups;
}

function dataFor(field: StateField, value: boolean, now: Date) {
  switch (field) {
    case "isRead":
      return { isRead: value, readAt: value ? now : null };
    case "isReadLater":
      return { isReadLater: value, readLaterSavedAt: value ? now : null };
    case "isStarred":
      return { isStarred: value };
  }
}

/**
 * Story cascade (K1, `User.clusterReadMode === "story"`): marking a story read
 * — its lead, or any source sent with `story: true` (the story card) — also
 * marks the cluster's other unread sources read. Returns one group per
 * originating story so the client can attribute Undo per story. User-scoped
 * (the cluster comes from the user's own article), bounded (at most
 * MAX_CASCADE_MEMBERS ids per batch), never an id the batch already touches
 * (an explicit op for a member wins). Costs nothing for unclustered articles.
 */
async function storyCascades(
  userId: string,
  ops: ArticleStateOp[],
  owned: Array<{ id: string; clusterId?: string | null; cluster?: { leadArticleId: string } | null }>,
): Promise<StoryCascade[]> {
  // Last isRead op per id decides ([true, false, true] ends as read, [true, false] as unread) —
  // the same "later op wins" rule `groupStateOps` applies to the write itself.
  const lastRead = new Map<string, ArticleStateOp>();
  for (const op of ops) if (op.isRead !== undefined) lastRead.set(op.id, op);
  // clusterId → origin op id (the lead wins over a story-card source of the same cluster).
  const origins = new Map<string, { id: string; lead: boolean }>();
  for (const row of owned) {
    const op = lastRead.get(row.id);
    if (!op?.isRead || !row.clusterId) continue;
    const lead = row.cluster?.leadArticleId === row.id;
    if (!lead && !op.story) continue;
    const current = origins.get(row.clusterId);
    if (!current || (!current.lead && lead)) origins.set(row.clusterId, { id: row.id, lead });
  }
  if (origins.size === 0) return [];
  const user = await db.user.findUnique({ where: { id: userId }, select: { clusterReadMode: true } });
  if (user?.clusterReadMode !== "story") return [];
  const touched = new Set(ops.map((op) => op.id));
  const members = await db.article.findMany({
    where: { userId, clusterId: { in: [...origins.keys()] }, isRead: false },
    select: { id: true, clusterId: true },
    orderBy: { id: "asc" },
    take: MAX_CASCADE_MEMBERS + touched.size,
  });
  const groups = new Map<string, StoryCascade>();
  let total = 0;
  for (const m of members) {
    if (touched.has(m.id) || !m.clusterId || total >= MAX_CASCADE_MEMBERS) continue;
    const origin = origins.get(m.clusterId);
    if (!origin) continue;
    const group = groups.get(m.clusterId) ?? { origin: origin.id, clusterId: m.clusterId, ids: [] };
    group.ids.push(m.id);
    groups.set(m.clusterId, group);
    total++;
  }
  return [...groups.values()];
}

export interface StateOpsResult {
  failed: string[];
  /** Every id the story cascade marked read (flat; = all `cascades[].ids`). */
  affected: string[];
  /** The same ids grouped by originating story. */
  cascades: StoryCascade[];
}

/**
 * Applies validated ops for `userId`. Ids that do not exist or belong to
 * another user are returned in `failed` (and nothing is written for them).
 * Every update is conditional on the field not already holding the value, so
 * repeating an op keeps `readAt` / `readLaterSavedAt` stable. All updates run
 * in one transaction.
 *
 * With `User.clusterReadMode = "story"`, marking a story read (its lead, or a
 * source sent with `story: true`) cascades to the cluster's other unread
 * sources; they come back in `cascades` (per story) and `affected` (flat) so
 * the client can patch its cache and undo them with explicit ops.
 */
export async function applyArticleStateOps(userId: string, ops: ArticleStateOp[]): Promise<StateOpsResult> {
  const ids = [...new Set(ops.map((op) => op.id))];
  const owned = await db.article.findMany({
    where: { userId, id: { in: ids } },
    select: { id: true, clusterId: true, cluster: { select: { leadArticleId: true } } },
  });
  const ownedIds = new Set(owned.map((a) => a.id));
  const failed = ids.filter((id) => !ownedIds.has(id));

  const ownedOps = ops.filter((op) => ownedIds.has(op.id));
  const cascades = ownedOps.some((op) => op.isRead === true) ? await storyCascades(userId, ownedOps, owned) : [];
  const affected = cascades.flatMap((c) => c.ids);
  const groups = groupStateOps([...ownedOps, ...affected.map((id) => ({ id, isRead: true }))]);
  if (groups.size === 0) return { failed, affected, cascades };

  const now = new Date();
  await db.$transaction(
    [...groups].map(([key, groupIds]) => {
      const [field, raw] = key.split(":") as [StateField, string];
      const value = raw === "true";
      return db.article.updateMany({
        where: { userId, id: { in: groupIds }, [field]: !value },
        data: dataFor(field, value, now),
      });
    }),
  );
  return { failed, affected, cascades };
}

/** Upper bound of ids one "mark up to here" call may send (loaded rows of a list, not a whole view). */
export const MAX_MARK_IDS = 1000;

const MarkIdsSchema = z.array(z.string().min(1).max(MAX_ID_LENGTH)).min(1).max(MAX_MARK_IDS);

export function parseMarkIds(input: unknown): { ok: true; ids: string[] } | { ok: false; error: string } {
  const parsed = MarkIdsSchema.safeParse(input);
  if (!parsed.success) return { ok: false, error: parsed.error.issues[0]?.message ?? "Invalid ids" };
  return { ok: true, ids: [...new Set(parsed.data)] };
}

/**
 * Bulk mark-read of explicit ids ("Alles bis hier als gelesen"): only the
 * user's own, still-unread articles change; returns exactly those ids (the
 * undo set, via UPDATE … RETURNING). Chunked short statements, `updatedAt`
 * untouched (server/articles/bulk-read.ts).
 */
export async function markIdsRead(userId: string, ids: string[]): Promise<string[]> {
  return (await setReadStateByIds(userId, ids, true)).ids;
}
