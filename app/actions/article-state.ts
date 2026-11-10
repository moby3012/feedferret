"use server";

import { auth } from "@/auth";
import { applyArticleStateOps as applyOps, parseStateOps } from "@/server/articles/state";

/**
 * The one write path for hot article toggles (read / star / read-later): the
 * client state batcher sends every op of one flush in a single call. Ops are
 * validated (shape, ≤200 per call) and user-scoped; ids the user does not own
 * come back in `failed`; `affected` lists extra articles marked read by the story
 * cascade (`clusterReadMode = "story"`) so the client can patch / undo them. No `revalidatePath`: the client cache is the owner.
 */
export async function applyArticleStateOps(ops: unknown): Promise<{ failed: string[]; affected: string[] }> {
  const session = await auth();
  if (!session?.user?.id) throw new Error("Unauthorized");
  const parsed = parseStateOps(ops);
  if (!parsed.ok) throw new Error(`Invalid ops: ${parsed.error}`);
  return applyOps(session.user.id, parsed.ops);
}
