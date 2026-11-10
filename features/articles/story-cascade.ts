import type { StoryCascade } from "./state-batcher";

// Client side of the server's story cascade (pure; tests/features/story-cascade.test.ts).

export interface CascadePlan {
  /** Per story: the ids to patch read and remember under its origin (Undo / story marked unread again). */
  groups: Array<{ origin: string; ids: string[] }>;
  /** Stories the user took back (origin unread again) while the call was in flight: restore at once. */
  restore: string[];
  /** Stories the Undo toast covers. */
  undo: string[];
  /** Ids the Undo toast counts. */
  total: number;
}

/**
 * Decides what a settled flush's cascade does to the cache. `pendingRead(id)`
 * is the isRead the user set after the flush left (queued or in flight), if
 * any: such ids keep that newer value — the cascade never overwrites it, and
 * they are not part of the story's undo set. `originRead(origin)` is the
 * story's current read state (pending write, else cache).
 */
export function planStoryCascade(
  cascades: readonly StoryCascade[],
  pendingRead: (id: string) => boolean | undefined,
  originRead: (origin: string) => boolean | undefined,
): CascadePlan {
  const plan: CascadePlan = { groups: [], restore: [], undo: [], total: 0 };
  for (const cascade of cascades) {
    const ids = cascade.ids.filter((id) => pendingRead(id) === undefined);
    if (ids.length === 0) continue;
    plan.groups.push({ origin: cascade.origin, ids });
    if (originRead(cascade.origin) === false) {
      plan.restore.push(cascade.origin);
    } else {
      plan.undo.push(cascade.origin);
      plan.total += ids.length;
    }
  }
  return plan;
}
