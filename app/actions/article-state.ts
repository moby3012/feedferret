"use server";

import { auth } from "@/auth";
import { applyArticleStateOps as applyOps, markIdsRead, parseMarkIds, parseStateOps, type StateOpsResult } from "@/server/articles/state";
import { RangeTooLargeError, markRangeRead, parseMarkRange } from "@/server/articles/mark-range";
import { createUndoToken } from "@/lib/undo-tokens";
import { checkRateLimit, RATE_LIMITS } from "@/lib/rate-limit";

/**
 * The one write path for hot article toggles (read / star / read-later): the
 * client state batcher sends every op of one flush in a single call. Ops are
 * validated (shape, ≤200 per call) and user-scoped; ids the user does not own
 * come back in `failed`; `cascades` (per originating story) / `affected` (flat)
 * list extra articles marked read by the story cascade (`clusterReadMode =
 * "story"`) so the client can patch / undo them. No `revalidatePath`: the
 * client cache is the owner. Rate-limited per user (`stateOps`, N13): above
 * the limit nothing is written, every op comes back in `failed` (the client
 * rolls them back) and `rateLimited` is set.
 */
export async function applyArticleStateOps(ops: unknown): Promise<StateOpsResult & { rateLimited?: true }> {
  const session = await auth();
  if (!session?.user?.id) throw new Error("Unauthorized");
  const parsed = parseStateOps(ops);
  if (!parsed.ok) throw new Error(`Invalid ops: ${parsed.error}`);
  if (!checkRateLimit(`user:${session.user.id}`, RATE_LIMITS.stateOps).success) {
    return { failed: [...new Set(parsed.ops.map((op) => op.id))], affected: [], cascades: [], rateLimited: true };
  }
  return applyOps(session.user.id, parsed.ops);
}

/**
 * "Alles bis hier als gelesen" (row context menu): marks the given loaded
 * rows read in one call and returns the ids that really changed plus a
 * server-side undo token for `markArticlesAsUnread` (same Undo path as
 * mark-all). Ids are capped and user-scoped; foreign ids are ignored.
 */
export async function markArticleIdsRead(ids: unknown): Promise<{ ids: string[]; undoToken: string | null; incomplete?: true }> {
  const session = await auth();
  if (!session?.user?.id) throw new Error("Unauthorized");
  const parsed = parseMarkIds(ids);
  if (!parsed.ok) throw new Error(`Invalid ids: ${parsed.error}`);
  const result = await markIdsRead(session.user.id, parsed.ids);
  const changed = result.ids;
  return { ids: changed, undoToken: changed.length ? createUndoToken(session.user.id, changed) : null, ...(result.complete ? {} : { incomplete: true as const }) };
}

/**
 * "Alles bis hier als gelesen" as a server-side range (no id list, no 1000
 * cap): every unread row of the bound list from its first loaded row down to
 * `toId`, plus folded story members (`extraIds`, capped). The scope is parsed
 * from the canonical list key with the list endpoint's own parser; user-scoped,
 * bounded; one undo token for everything it changed. Rate-limited per user
 * (`rangeMark`, N13): above the limit nothing changes and `rateLimited` is set.
 */
export async function markListRangeRead(input: unknown): Promise<{ ids: string[]; undoToken: string | null; tooLarge?: { limit: number }; rateLimited?: true; incomplete?: true }> {
  const session = await auth();
  if (!session?.user?.id) throw new Error("Unauthorized");
  const parsed = parseMarkRange(input);
  if (!parsed.ok) throw new Error(`Invalid range: ${parsed.error}`);
  if (!checkRateLimit(`user:${session.user.id}`, RATE_LIMITS.rangeMark).success) return { ids: [], undoToken: null, rateLimited: true };
  let result: Awaited<ReturnType<typeof markRangeRead>>;
  try {
    result = await markRangeRead(session.user.id, parsed.range);
  } catch (error) {
    // Above the bound nothing changed; tell the client (production masks thrown messages).
    if (error instanceof RangeTooLargeError) return { ids: [], undoToken: null, tooLarge: { limit: error.limit } };
    throw error;
  }
  const changed = result.ids;
  return { ids: changed, undoToken: changed.length ? createUndoToken(session.user.id, changed) : null, ...(result.complete ? {} : { incomplete: true as const }) };
}
