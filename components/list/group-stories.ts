import type { LegacyArticle } from "@/features/articles/legacy-adapter";

// Story cluster grouping of a loaded list (pure; tests/features/group-stories.test.ts).

export interface StoryGroup {
  clusterId: string;
  /** The row that stands for the story in the list (the lead when it is loaded). */
  rep: LegacyArticle;
  /** Other members that are in the loaded list (collapsed under the card). */
  siblings: LegacyArticle[];
  /** Other sources of the story (server cluster size − 1). */
  more: number;
}

export interface DisplayRow {
  article: LegacyArticle;
  story: StoryGroup | null;
}

/**
 * One row per story: the first occurrence of a cluster in list order becomes
 * the card (showing the lead if it is loaded), later members collapse under
 * it. Rows outside a cluster pass through unchanged. Pure.
 */
export function groupStories(articles: readonly LegacyArticle[]): DisplayRow[] {
  const byCluster = new Map<string, LegacyArticle[]>();
  for (const a of articles) {
    if (!a.clusterId || a.clusterSize < 2) continue;
    const list = byCluster.get(a.clusterId);
    if (list) list.push(a);
    else byCluster.set(a.clusterId, [a]);
  }
  const out: DisplayRow[] = [];
  const placed = new Set<string>();
  for (const a of articles) {
    const members = a.clusterId && a.clusterSize >= 2 ? byCluster.get(a.clusterId) : undefined;
    if (!members) {
      out.push({ article: a, story: null });
      continue;
    }
    if (placed.has(a.clusterId!)) continue;
    placed.add(a.clusterId!);
    const rep = members.find((m) => m.id === m.clusterLeadId) ?? members[0];
    out.push({
      article: rep,
      story: { clusterId: a.clusterId!, rep, siblings: members.filter((m) => m !== rep), more: Math.max(a.clusterSize - 1, members.length - 1) },
    });
  }
  return out;
}
