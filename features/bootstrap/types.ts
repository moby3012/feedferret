// Wire types of the bootstrap / counts endpoints (.pm/spec-shell-design.md §2.2).

/**
 * Unread / membership counts of the signed-in user. "Unread" always means
 * unread, not a spoiler, and not a hidden duplicate — exactly what the list
 * scopes show, so sidebar badges and list headers agree.
 */
export interface Counts {
  /** Unread in "All articles" (feeds / categories hidden from it excluded). */
  unreadTotal: number;
  byFeed: Record<string, number>;
  byLabel: Record<string, number>;
  later: number;
  starred: number;
  spoiler: number;
  notifications: number;
}

export const EMPTY_COUNTS: Counts = Object.freeze({
  unreadTotal: 0,
  byFeed: Object.freeze({}) as Record<string, number>,
  byLabel: Object.freeze({}) as Record<string, number>,
  later: 0,
  starred: 0,
  spoiler: 0,
  notifications: 0,
});
