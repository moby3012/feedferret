import { z } from "zod";
import { db } from "@/lib/db";

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
}

/** Upper bound of members one batch may mark read through story cascading (clusters are capped at 50 sources). */
export const MAX_CASCADE_MEMBERS = 500;

/** Upper bound of ops per call. The batcher flushes at least every second, so a real client stays far below. */
export const MAX_STATE_OPS = 200;
const MAX_ID_LENGTH = 128;

const OpSchema = z
  .object({
    id: z.string().min(1).max(MAX_ID_LENGTH),
    isRead: z.boolean().optional(),
    isStarred: z.boolean().optional(),
    isReadLater: z.boolean().optional(),
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
 * Story cascade (K1, `User.clusterReadMode === "story"`): marking the lead of a
 * cluster read also marks its other unread sources read. Returns the member
 * ids to add — user-scoped, bounded, never an id the batch already touches
 * (an explicit op for a member wins). Costs nothing for unclustered articles.
 */
async function storyCascadeIds(
  userId: string,
  ops: ArticleStateOp[],
  owned: Array<{ id: string; clusterId?: string | null; cluster?: { leadArticleId: string } | null }>,
): Promise<string[]> {
  const readOps = new Set(ops.filter((op) => op.isRead === true).map((op) => op.id));
  // Last op per id decides: a later isRead:false cancels an earlier isRead:true.
  for (const op of ops) if (op.isRead === false) readOps.delete(op.id);
  const clusterIds = new Set<string>();
  for (const row of owned) {
    if (readOps.has(row.id) && row.clusterId && row.cluster?.leadArticleId === row.id) clusterIds.add(row.clusterId);
  }
  if (clusterIds.size === 0) return [];
  const user = await db.user.findUnique({ where: { id: userId }, select: { clusterReadMode: true } });
  if (user?.clusterReadMode !== "story") return [];
  const touched = new Set(ops.map((op) => op.id));
  const members = await db.article.findMany({
    where: { userId, clusterId: { in: [...clusterIds] }, isRead: false },
    select: { id: true },
    orderBy: { id: "asc" },
    take: MAX_CASCADE_MEMBERS + touched.size,
  });
  return members.map((m) => m.id).filter((id) => !touched.has(id)).slice(0, MAX_CASCADE_MEMBERS);
}

/**
 * Applies validated ops for `userId`. Ids that do not exist or belong to
 * another user are returned in `failed` (and nothing is written for them).
 * Every update is conditional on the field not already holding the value, so
 * repeating an op keeps `readAt` / `readLaterSavedAt` stable. All updates run
 * in one transaction.
 *
 * With `User.clusterReadMode = "story"`, marking a story's lead read cascades
 * to the cluster's other unread sources; their ids come back in `affected` so
 * the client can patch its cache (and undo them with explicit ops).
 */
export async function applyArticleStateOps(userId: string, ops: ArticleStateOp[]): Promise<{ failed: string[]; affected: string[] }> {
  const ids = [...new Set(ops.map((op) => op.id))];
  const owned = await db.article.findMany({
    where: { userId, id: { in: ids } },
    select: { id: true, clusterId: true, cluster: { select: { leadArticleId: true } } },
  });
  const ownedIds = new Set(owned.map((a) => a.id));
  const failed = ids.filter((id) => !ownedIds.has(id));

  const ownedOps = ops.filter((op) => ownedIds.has(op.id));
  const affected = ownedOps.some((op) => op.isRead === true) ? await storyCascadeIds(userId, ownedOps, owned) : [];
  const groups = groupStateOps([...ownedOps, ...affected.map((id) => ({ id, isRead: true }))]);
  if (groups.size === 0) return { failed, affected };

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
  return { failed, affected };
}
