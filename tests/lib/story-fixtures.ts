// Shared loader for tests/fixtures/story-headlines*.json: turns fixture items
// into engine inputs (signatures computed exactly like the job does).
import fixture from "../fixtures/story-headlines.json";
import holdout from "../fixtures/story-headlines-holdout.json";
import { computeStorySig } from "../../lib/story-clustering/normalize";
import type { PendingItem } from "../../lib/story-clustering/types";

export interface FixtureItem {
  feed: string;
  title: string;
  hoursAgo: number;
  excerpt?: string;
  links?: string[];
}
export interface FixtureGroup {
  id: string;
  lang: string;
  expect: "same" | "distinct";
  items: FixtureItem[];
  note?: string;
  /** Same story as another group (cross-language duplicate group). */
  sameStoryAs?: string;
}
type FeedMeta = { name: string; host: string; priority: string };

export const NOW = Date.UTC(2026, 10, 10, 12, 0, 0);
export const groups = fixture.groups as FixtureGroup[];
export const holdoutGroups = holdout.groups as FixtureGroup[];
export const filler = fixture.filler as FixtureItem[];
const feeds = fixture.feeds as Record<string, FeedMeta>;

export function toPending(item: FixtureItem, id: string, now = NOW): PendingItem {
  const meta = feeds[item.feed];
  const body = (item.links ?? []).map((l) => `<a href="${l}">source</a>`).join(" ");
  return {
    id,
    feedId: item.feed,
    publishedAt: now - item.hoursAgo * 3_600_000,
    sig: computeStorySig({
      title: item.title,
      excerpt: item.excerpt,
      content: body,
      link: `https://${meta.host}/a/${id}`,
      feedName: meta.name,
      feedPriority: meta.priority,
    }),
  };
}

export interface Labeled extends PendingItem {
  group: string;
  /** Ground-truth story key (groups with sameStoryAs share one). */
  story: string;
  expect: "same" | "distinct" | "filler";
  title: string;
}

/** Items of the given groups (default: main fixture) plus the shared filler corpus. */
export function allItems(selected: FixtureGroup[] = groups, withFiller = true): Labeled[] {
  const out: Labeled[] = [];
  for (const g of selected) {
    g.items.forEach((it, i) =>
      out.push({ ...toPending(it, `${g.id}#${i}`), group: g.id, story: g.sameStoryAs ?? g.id, expect: g.expect, title: it.title }),
    );
  }
  if (withFiller) {
    filler.forEach((it, i) => out.push({ ...toPending(it, `filler#${i}`), group: "filler", story: `filler#${i}`, expect: "filler", title: it.title }));
  }
  return out;
}

export interface Evaluation {
  /** group id → ids of the clusters its items ended up in ("-" = singleton) */
  perGroup: Map<string, { expect: string; size: number; clusters: string[]; ok: boolean }>;
  tp: number;
  fp: number;
  fn: number;
  precision: number;
  recall: number;
  clusters: Map<string, string[]>;
}

/** Pairwise precision / recall of a decision list against the fixture ground truth. */
export function evaluate(items: Labeled[], decisions: Array<{ articleId: string; action: string; clusterId?: string; partnerId?: string }>): Evaluation {
  const memberOf = new Map<string, string>();
  for (const d of decisions) {
    if (d.action === "create") {
      memberOf.set(d.partnerId!, d.clusterId!);
      memberOf.set(d.articleId, d.clusterId!);
    } else if (d.action === "join") memberOf.set(d.articleId, d.clusterId!);
  }
  const clusters = new Map<string, string[]>();
  for (const [a, c] of memberOf) clusters.set(c, [...(clusters.get(c) ?? []), a]);
  let tp = 0;
  let fp = 0;
  let fn = 0;
  for (let i = 0; i < items.length; i++) {
    for (let j = i + 1; j < items.length; j++) {
      const a = items[i];
      const b = items[j];
      const truth = a.story === b.story && a.expect === "same" && b.expect === "same" && a.feedId !== b.feedId;
      const together = memberOf.has(a.id) && memberOf.get(a.id) === memberOf.get(b.id);
      if (together && truth) tp++;
      else if (together) fp++;
      else if (truth) fn++;
    }
  }
  const perGroup = new Map<string, { expect: string; size: number; clusters: string[]; ok: boolean }>();
  for (const it of items) {
    const entry = perGroup.get(it.group) ?? { expect: it.expect, size: 0, clusters: [], ok: true };
    entry.size++;
    entry.clusters.push(memberOf.get(it.id) ?? "-");
    perGroup.set(it.group, entry);
  }
  for (const [group, e] of perGroup) {
    if (group === "filler") e.ok = e.clusters.every((c) => c === "-");
    else if (e.expect === "same") e.ok = new Set(e.clusters).size === 1 && e.clusters[0] !== "-";
    else e.ok = e.clusters.every((c) => c === "-");
  }
  return {
    perGroup,
    tp,
    fp,
    fn,
    precision: tp + fp === 0 ? 1 : tp / (tp + fp),
    recall: tp + fn === 0 ? 1 : tp / (tp + fn),
    clusters,
  };
}
