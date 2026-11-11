/**
 * A category may be offered for inline deletion only when it is truly empty: no
 * feed of the user points at it (hidden-by-"hide empty feeds" ones included) and
 * no subcategory hangs below it (deleting a parent cascades to its children).
 * `feeds` / `categories` must be the full, unfiltered lists.
 */
export function isDeletableEmptyCategory(
  categoryId: string,
  feeds: ReadonlyArray<{ categoryId?: string | null }>,
  categories: ReadonlyArray<{ id: string; parentId?: string | null; children?: ReadonlyArray<unknown> | null }>,
): boolean {
  const category = categories.find((c) => c.id === categoryId);
  if (!category) return false;
  if (feeds.some((f) => f.categoryId === categoryId)) return false;
  if (category.children && category.children.length > 0) return false;
  if (categories.some((c) => c.parentId === categoryId)) return false;
  return true;
}
