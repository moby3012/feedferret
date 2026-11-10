import type { LegacyArticle } from "@/features/articles/legacy-adapter";
import type { DisplayRow } from "./group-stories";

// "Alles bis hier als gelesen" (row context menu): what exactly "up to here"
// covers, from the list as it is DISPLAYED (pure; tests/features/mark-up-to-here.test.ts).

/** Upper bound of ids the explicit-id path may send (server `MAX_MARK_IDS`). */
export const MAX_MARK_IDS = 1000;
/** Upper bound of rows one server range may change, extra ids included (server `MAX_RANGE_IDS`). */
export const MAX_RANGE_IDS = 20_000;

export interface UpToHereInput {
  /** Display rows (one per story card) in list order. */
  rows: readonly DisplayRow[];
  /** The flat loaded list (list order) the rows were grouped from. */
  flat: readonly LegacyArticle[];
  /** Member rows an EXPANDED card shows under it (fetched cluster members, card excluded); null when collapsed. */
  expandedMembers: (clusterId: string) => readonly LegacyArticle[] | null;
  /** The row the menu was opened on (a card, a plain row or an expanded member row). */
  targetId: string;
  /**
   * Server-issued snapshot time (ms) of the bound list's first page; null =
   * no bound list / no snapshot (explicit ids only).
   */
  cutoff: number | null;
}

export type UpToHerePlan =
  | { kind: "none" }
  | { kind: "range"; fromId: string; toId: string; extraIds: string[]; unread: number }
  | { kind: "ids"; ids: string[] }
  | { kind: "too-many"; limit: number };

/**
 * The articles of the list in display order: each card, then — when expanded —
 * the members it shows, then the loaded siblings folded under it that the
 * expanded part does not show (a collapsed card stands for its siblings).
 * Each id once (first occurrence).
 */
export function displayOrder(rows: readonly DisplayRow[], expandedMembers: UpToHereInput["expandedMembers"]): LegacyArticle[] {
  const seen = new Set<string>();
  const out: LegacyArticle[] = [];
  const push = (a: LegacyArticle) => {
    if (seen.has(a.id)) return;
    seen.add(a.id);
    out.push(a);
  };
  for (const row of rows) {
    push(row.article);
    if (!row.story) continue;
    for (const m of expandedMembers(row.story.clusterId) ?? []) push(m);
    for (const s of row.story.siblings) push(s);
  }
  return out;
}

/**
 * Plans "up to here" for `targetId`: everything displayed at or above it.
 *
 * With a bound list + snapshot it becomes ONE server range over the longest
 * prefix of the flat list that is fully covered, capped at the snapshot time
 * (`createdAt <= cutoff`: rows that arrived after the first page was loaded —
 * also backdated ones inside an already loaded span — stay out), plus every
 * other covered unread row as explicit ids (expanded members fetched outside
 * the list, siblings below the prefix, rows newer than the snapshot that the
 * list does show). Never a silent partial: above the server bound it refuses.
 */
export function planMarkUpToHere(input: UpToHereInput): UpToHerePlan {
  const order = displayOrder(input.rows, input.expandedMembers);
  const at = order.findIndex((a) => a.id === input.targetId);
  const covered = at >= 0 ? order.slice(0, at + 1) : [];
  const unread = covered.filter((a) => !a.isRead);
  if (unread.length === 0) return { kind: "none" };

  const { flat, cutoff } = input;
  if (cutoff !== null && flat.length > 0) {
    const inCovered = new Set(covered.map((a) => a.id));
    let k = flat.findIndex((a) => !inCovered.has(a.id));
    k = k === -1 ? flat.length - 1 : k - 1;
    if (k >= 0) {
      const inRange = new Set(flat.slice(0, k + 1).filter((a) => Number.isFinite(a.createdAtRaw) && a.createdAtRaw <= cutoff).map((a) => a.id));
      const extraIds = unread.filter((a) => !inRange.has(a.id)).map((a) => a.id);
      if (extraIds.length > MAX_RANGE_IDS) return { kind: "too-many", limit: MAX_RANGE_IDS };
      return { kind: "range", fromId: flat[0].id, toId: flat[k].id, extraIds, unread: unread.length };
    }
  }
  if (unread.length > MAX_MARK_IDS) return { kind: "too-many", limit: MAX_MARK_IDS };
  return { kind: "ids", ids: unread.map((a) => a.id) };
}
