import { db } from "@/lib/db";

/** Max entries accepted by bulk reorder actions (bounds work per request). */
export const MAX_REORDER_ITEMS = 2000;

/**
 * Throws unless every non-empty id is a category owned by `userId`. Used for
 * parentId / categoryId inputs so nothing can be attached to another account.
 */
export async function assertOwnedCategories(userId: string, ids: Iterable<unknown>): Promise<void> {
  const unique = [...new Set([...ids].filter((id): id is string => typeof id === "string" && id.length > 0))];
  if (unique.length === 0) return;
  const owned = await db.category.count({ where: { id: { in: unique }, userId } });
  if (owned !== unique.length) throw new Error("Invalid category");
}
