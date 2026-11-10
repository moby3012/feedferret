"use server";

import { auth } from "@/auth";
import { applyArticleStateOps as applyOps, markIdsRead, parseMarkIds, parseStateOps, type StateOpsResult } from "@/server/articles/state";
import { markRangeRead, parseMarkRange } from "@/server/articles/mark-range";
import { createUndoToken } from "@/lib/undo-tokens";

/**
 * The one write path for hot article toggles (read / star / read-later): the
 * client state batcher sends every op of one flush in a single call. Ops are
 * validated (shape, ≤200 per call) and user-scoped; ids the user does not own
 * come back in `failed`; `cascades` (per originating story) / `affected` (flat)
 * list extra articles marked read by the story cascade (`clusterReadMode =
 * "story"`) so the client can patch / undo them. No `revalidatePath`: the
 * client cache is the owner.
 */
export async function applyArticleStateOps(ops: unknown): Promise<StateOpsResult> {
  const session = await auth();
  if (!session?.user?.id) throw new Error("Unauthorized");
  const parsed = parseStateOps(ops);
  if (!parsed.ok) throw new Error(`Invalid ops: ${parsed.error}`);
  return applyOps(session.user.id, parsed.ops);
}

/**
 * "Alles bis hier als gelesen" (row context menu): marks the given loaded
 * rows read in one call and returns the ids that really changed plus a
 * server-side undo token for `markArticlesAsUnread` (same Undo path as
 * mark-all). Ids are capped and user-scoped; foreign ids are ignored.
 */
export async function markArticleIdsRead(ids: unknown): Promise<{ ids: string[]; undoToken: string | null }> {
  const session = await auth();
  if (!session?.user?.id) throw new Error("Unauthorized");
  const parsed = parseMarkIds(ids);
  if (!parsed.ok) throw new Error(`Invalid ids: ${parsed.error}`);
  const changed = await markIdsRead(session.user.id, parsed.ids);
  return { ids: changed, undoToken: changed.length ? createUndoToken(session.user.id, changed) : null };
}

/**
 * "Alles bis hier als gelesen" as a server-side range (no id list, no 1000
 * cap): every unread row of the bound list from its first loaded row down to
 * `toId`, plus folded story members (`extraIds`, capped). The scope is parsed
 * from the canonical list key with the list endpoint's own parser; user-scoped,
 * bounded; one undo token for everything it changed.
 */
export async function markListRangeRead(input: unknown): Promise<{ ids: string[]; undoToken: string | null }> {
  const session = await auth();
  if (!session?.user?.id) throw new Error("Unauthorized");
  const parsed = parseMarkRange(input);
  if (!parsed.ok) throw new Error(`Invalid range: ${parsed.error}`);
  const changed = await markRangeRead(session.user.id, parsed.range);
  return { ids: changed, undoToken: changed.length ? createUndoToken(session.user.id, changed) : null };
}
