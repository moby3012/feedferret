// Shared types of the story clustering engine (K1, no-AI tier).

/** Per-article signature, stored as JSON in `Article.storySig` (<= 600 chars). */
export interface StorySig {
  v: 1;
  /** Content tokens: normalized, stemmed, deduped, <= 16. */
  t: string[];
  /** Entities (lowercased), <= 8. */
  e: string[];
  /** sha1-12 of normalized outbound links, <= 8. */
  l: string[];
  /** Language guess used for stemming / entity rules. */
  g?: "de" | "en";
  /** Lead-pick quality (feed priority, image, length, clickbait); higher wins. */
  q?: number;
  /** Excluded from clustering (liveblog, newsletter, too few tokens…). */
  x?: 1;
}

/** Per-cluster signature, stored as JSON in `StoryCluster.sig` (<= 2 KB). */
export interface ClusterSig {
  /** token -> number of members containing it (top 24). */
  t: Record<string, number>;
  e: string[];
  /** Signature of the lead article, the drift-guard anchor. */
  lead: StorySig;
}

export interface WindowItem {
  id: string;
  feedId: string;
  /** epoch ms */
  publishedAt: number;
  clusterId: string | null;
  sig: StorySig;
}

export interface PendingItem {
  id: string;
  feedId: string;
  publishedAt: number;
  sig: StorySig;
}

export interface ClusterState {
  id: string;
  leadArticleId: string;
  size: number;
  feedIds: string[];
  firstSeenAt: number;
  lastSeenAt: number;
  sig: ClusterSig;
}

export type ClusterAction = "join" | "create" | "single" | "skip";

export interface ClusterDecision {
  articleId: string;
  action: ClusterAction;
  /** join: existing cluster id; create: the new cluster's (client generated) id. */
  clusterId?: string;
  /** create: the already-seen singleton this article forms a cluster with. */
  partnerId?: string;
  score?: number;
}
