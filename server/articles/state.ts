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
 * Applies validated ops for `userId`. Ids that do not exist or belong to
 * another user are returned in `failed` (and nothing is written for them).
 * Every update is conditional on the field not already holding the value, so
 * repeating an op keeps `readAt` / `readLaterSavedAt` stable. All updates run
 * in one transaction.
 */
export async function applyArticleStateOps(userId: string, ops: ArticleStateOp[]): Promise<{ failed: string[] }> {
  const ids = [...new Set(ops.map((op) => op.id))];
  const owned = await db.article.findMany({ where: { userId, id: { in: ids } }, select: { id: true } });
  const ownedIds = new Set(owned.map((a) => a.id));
  const failed = ids.filter((id) => !ownedIds.has(id));

  const groups = groupStateOps(ops.filter((op) => ownedIds.has(op.id)));
  if (groups.size === 0) return { failed };

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
  return { failed };
}
