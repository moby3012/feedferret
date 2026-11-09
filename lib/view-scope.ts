/**
 * Views that only ever contain articles the user already read (or must not be
 * bulk-touched) — "mark all read" does not apply to them. Shared by server
 * (`markAllAsRead`, `getViewUnreadCount`) and client (hiding the controls).
 */
const NO_MARK_ALL_CATEGORIES = new Set(["Recently Read", "Spoiler"]);

export function isMarkAllAllowed(feedId: string | null | undefined, category: string | null | undefined): boolean {
  if (feedId) return true;
  return !category || !NO_MARK_ALL_CATEGORIES.has(category);
}
