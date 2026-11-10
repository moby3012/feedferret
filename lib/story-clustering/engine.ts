import { CONFIG, makeIdf, prepare, scorePair, type IdfFn } from "./similarity";
import type { ClusterDecision, ClusterSig, ClusterState, PendingItem, StorySig, WindowItem } from "./types";

// Pure assignment engine (no DB, no clock): pending articles → join / create /
// single / skip decisions against an in-memory 48 h window. Deterministic for a
// given (pending, window, clusters) state regardless of input order.

export interface EngineOptions {
  /** Id for a cluster formed from `partner` + `article`; must be unique and stable per call. Default: `cl_<partnerId>`. */
  newClusterId?: (partnerId: string, articleId: string) => string;
}

export interface EngineResult {
  decisions: ClusterDecision[];
  /** Final state of every cluster created or changed by this run. */
  clusters: ClusterState[];
}

interface Node {
  id: string;
  feedId: string;
  t: number;
  sig: StorySig;
  clusterId: string | null;
}

const TOP_TOKENS = 24;
const MAX_CLUSTER_ENTITIES = 12;

function bump(map: Map<string, Node[]>, key: string, node: Node) {
  const list = map.get(key);
  if (list) list.push(node);
  else map.set(key, [node]);
}

/** Lead order: higher quality, then earlier, then smaller id. */
export function betterLead(a: { q: number; t: number; id: string }, b: { q: number; t: number; id: string }): boolean {
  if (a.q !== b.q) return a.q > b.q;
  if (a.t !== b.t) return a.t < b.t;
  return a.id < b.id;
}

function clusterSigOf(tokenCounts: Map<string, number>, entities: string[], lead: StorySig, anchor?: StorySig[]): ClusterSig {
  const top = [...tokenCounts].sort((x, y) => y[1] - x[1] || (x[0] < y[0] ? -1 : 1)).slice(0, TOP_TOKENS);
  return { t: Object.fromEntries(top), e: entities.slice(0, MAX_CLUSTER_ENTITIES), lead, ...(anchor?.length ? { anchor } : {}) };
}

/** Compact copy of a signature for the cluster's drift anchor (no link hashes, no lead-pick fields). */
export function anchorOf(sig: StorySig): StorySig {
  return { v: 1, t: sig.t, e: sig.e, l: [], ...(sig.g ? { g: sig.g } : {}) };
}

/**
 * Incremental engine: construct once per (user, run) — builds the idf table and
 * the inverted index over the window — then `step(n)` processes the next n
 * pending articles (oldest first) so the caller can yield / check a budget
 * between steps. Decisions are identical to a single-shot run.
 */
export class ClusterEngine {
  private readonly pending: PendingItem[];
  private cursor = 0;
  private readonly step_: (item: PendingItem) => ClusterDecision;
  private readonly touchedIds = new Set<string>();
  private readonly clusters: Map<string, ClusterState>;

  constructor(pendingInput: PendingItem[], windowItems: WindowItem[], clusterInput: ClusterState[], opts: EngineOptions = {}) {
    this.pending = [...pendingInput].sort((a, b) => a.publishedAt - b.publishedAt || (a.id < b.id ? -1 : 1));
    const built = buildEngine(this.pending, windowItems, clusterInput, opts, this.touchedIds);
    this.step_ = built.assign;
    this.clusters = built.clusters;
  }

  get remaining(): number {
    return this.pending.length - this.cursor;
  }

  /** Processes up to `n` more pending articles. */
  step(n: number): ClusterDecision[] {
    const out: ClusterDecision[] = [];
    while (out.length < n && this.cursor < this.pending.length) out.push(this.step_(this.pending[this.cursor++]));
    return out;
  }

  /** Cluster states created / changed since the last call (sorted by id). */
  drainTouched(): ClusterState[] {
    const ids = [...this.touchedIds].sort();
    this.touchedIds.clear();
    return ids.map((id) => structuredClone(this.clusters.get(id)!));
  }
}

/** One-shot convenience wrapper (tests, backfill tools). */
export function assignClusters(
  pendingInput: PendingItem[],
  windowItems: WindowItem[],
  clusterInput: ClusterState[],
  opts: EngineOptions = {},
): EngineResult {
  const engine = new ClusterEngine(pendingInput, windowItems, clusterInput, opts);
  const decisions = engine.step(Infinity);
  return { decisions, clusters: engine.drainTouched() };
}

function buildEngine(
  pending: PendingItem[],
  windowItems: WindowItem[],
  clusterInput: ClusterState[],
  opts: EngineOptions,
  touched: Set<string>,
): { assign: (item: PendingItem) => ClusterDecision; clusters: Map<string, ClusterState> } {
  const newClusterId = opts.newClusterId ?? ((partnerId: string) => `cl_${partnerId}`);
  // ---- idf over window ∪ pending (excluded sigs do not count)
  const df = new Map<string, number>();
  let n = 0;
  const countSig = (sig: StorySig) => {
    if (sig.x) return;
    n++;
    for (const t of sig.t) df.set(t, (df.get(t) ?? 0) + 1);
  };
  for (const w of windowItems) countSig(w.sig);
  for (const p of pending) countSig(p.sig);
  const idf: IdfFn = makeIdf(df, n);

  // ---- state
  const clusters = new Map<string, ClusterState>();
  for (const c of clusterInput) clusters.set(c.id, { ...c, feedIds: [...c.feedIds], sig: { ...c.sig } });
  const members = new Map<string, Node[]>(); // clusterId → nodes (for lead lookup of publishedAt)
  const nodes = new Map<string, Node>();
  const tokenIndex = new Map<string, Node[]>();
  const entityIndex = new Map<string, Node[]>();
  const linkIndex = new Map<string, Node[]>();

  const index = (node: Node) => {
    nodes.set(node.id, node);
    if (node.clusterId) {
      const list = members.get(node.clusterId);
      if (list) list.push(node);
      else members.set(node.clusterId, [node]);
    }
    if (node.sig.x) return;
    for (const t of node.sig.t) if (idf(t) >= CONFIG.blockingIdf) bump(tokenIndex, t, node);
    for (const e of node.sig.e) bump(entityIndex, e, node);
    for (const l of node.sig.l) bump(linkIndex, l, node);
  };
  for (const w of windowItems) index({ id: w.id, feedId: w.feedId, t: w.publishedAt, sig: w.sig, clusterId: w.clusterId });

  const assign = (item: PendingItem): ClusterDecision => {
    const node: Node = { id: item.id, feedId: item.feedId, t: item.publishedAt, sig: item.sig, clusterId: null };
    if (item.sig.x) {
      return { articleId: item.id, action: "skip" };
    }
    const prepared = prepare(item.sig);

    // ---- candidates: shared indexed term count
    const counts = new Map<Node, number>();
    const visit = (list: Node[] | undefined) => {
      if (!list) return;
      for (const c of list) {
        if (c.id === item.id) continue;
        counts.set(c, (counts.get(c) ?? 0) + 1);
      }
    };
    for (const t of item.sig.t) if (idf(t) >= CONFIG.blockingIdf) visit(tokenIndex.get(t));
    for (const e of item.sig.e) visit(entityIndex.get(e));
    for (const l of item.sig.l) visit(linkIndex.get(l));
    const candidates = [...counts]
      .sort((x, y) => y[1] - x[1] || x[0].t - y[0].t || (x[0].id < y[0].id ? -1 : 1))
      .slice(0, CONFIG.maxCandidates)
      .map(([c]) => c);

    // ---- best score per target (cluster id, or singleton node id)
    type Target = { kind: "cluster"; id: string; score: number } | { kind: "single"; id: string; score: number };
    const best = new Map<string, Target>();
    for (const c of candidates) {
      if (c.feedId === item.feedId) continue; // same-feed pairs never join
      const cluster = c.clusterId ? clusters.get(c.clusterId) : undefined;
      if (c.clusterId && !cluster) continue;
      const ps = scorePair(prepared, prepare(c.sig), idf, Math.abs(item.publishedAt - c.t));
      if (!ps || !ps.join) continue;
      const key = c.clusterId ? `c:${c.clusterId}` : `s:${c.id}`;
      const prev = best.get(key);
      if (!prev || ps.score > prev.score) {
        best.set(key, c.clusterId ? { kind: "cluster", id: c.clusterId, score: ps.score } : { kind: "single", id: c.id, score: ps.score });
      }
    }

    // ---- drift guard + cluster constraints, then pick max
    let pick: Target | null = null;
    let pickFirstSeen = Infinity;
    for (const target of best.values()) {
      let firstSeen = nodes.get(target.id)?.t ?? 0;
      if (target.kind === "cluster") {
        const cluster = clusters.get(target.id)!;
        if (cluster.size >= CONFIG.maxClusterSize) continue;
        if (cluster.feedIds.includes(item.feedId)) continue;
        if (cluster.lastSeenAt < item.publishedAt - CONFIG.windowMs) continue;
        const drift = scorePair(prepared, prepare(cluster.sig.lead), idf, Math.abs(item.publishedAt - (nodes.get(cluster.leadArticleId)?.t ?? cluster.firstSeenAt)));
        // lead outside the time window → fall back to cluster span for the time term
        if (!drift || drift.score < CONFIG.driftThreshold) continue;
        // Anchor of the first two members: the lead may have been swapped several times, so
        // resembling it is not enough — the joiner must also resemble where the story began.
        const anchors = cluster.sig.anchor;
        if (anchors?.length) {
          const dt = Math.min(CONFIG.windowMs, Math.abs(item.publishedAt - cluster.firstSeenAt));
          const anchored = anchors.some((a) => {
            const s = scorePair(prepared, prepare(a), idf, dt);
            return !!s && s.score >= CONFIG.driftThreshold;
          });
          if (!anchored) continue;
        }
        firstSeen = cluster.firstSeenAt;
      }
      if (
        !pick ||
        target.score > pick.score + 1e-12 ||
        (Math.abs(target.score - pick.score) <= 1e-12 && (firstSeen < pickFirstSeen || (firstSeen === pickFirstSeen && target.id < pick.id)))
      ) {
        pick = target;
        pickFirstSeen = firstSeen;
      }
    }

    if (!pick) {
      index(node);
      return { articleId: item.id, action: "single" };
    }

    if (pick.kind === "cluster") {
      const cluster = clusters.get(pick.id)!;
      node.clusterId = cluster.id;
      cluster.size += 1;
      cluster.feedIds.push(item.feedId);
      cluster.firstSeenAt = Math.min(cluster.firstSeenAt, item.publishedAt);
      cluster.lastSeenAt = Math.max(cluster.lastSeenAt, item.publishedAt);
      const counts2 = new Map(Object.entries(cluster.sig.t));
      for (const t of item.sig.t) counts2.set(t, (counts2.get(t) ?? 0) + 1);
      const entities = [...new Set([...cluster.sig.e, ...item.sig.e])];
      const leadNode = nodes.get(cluster.leadArticleId);
      const cur = { q: cluster.sig.lead.q ?? 0, t: leadNode?.t ?? cluster.firstSeenAt, id: cluster.leadArticleId };
      const cand = { q: item.sig.q ?? 0, t: item.publishedAt, id: item.id };
      const lead = betterLead(cand, cur) ? item : null;
      if (lead) {
        cluster.leadArticleId = item.id;
        cluster.sig = clusterSigOf(counts2, entities, item.sig, cluster.sig.anchor);
      } else {
        cluster.sig = clusterSigOf(counts2, entities, cluster.sig.lead, cluster.sig.anchor);
      }
      touched.add(cluster.id);
      index(node);
      return { articleId: item.id, action: "join", clusterId: cluster.id, score: pick.score };
    } else {
      const partner = nodes.get(pick.id)!;
      const id = newClusterId(partner.id, item.id);
      node.clusterId = id;
      partner.clusterId = id;
      const counts2 = new Map<string, number>();
      for (const t of [...partner.sig.t, ...item.sig.t]) counts2.set(t, (counts2.get(t) ?? 0) + 1);
      const pCand = { q: partner.sig.q ?? 0, t: partner.t, id: partner.id };
      const nCand = { q: item.sig.q ?? 0, t: item.publishedAt, id: item.id };
      const leadIsNew = betterLead(nCand, pCand);
      const leadNode = leadIsNew ? node : partner;
      clusters.set(id, {
        id,
        leadArticleId: leadNode.id,
        size: 2,
        feedIds: [partner.feedId, item.feedId],
        firstSeenAt: Math.min(partner.t, item.publishedAt),
        lastSeenAt: Math.max(partner.t, item.publishedAt),
        sig: clusterSigOf(counts2, [...new Set([...partner.sig.e, ...item.sig.e])], leadNode.sig, [anchorOf(partner.sig), anchorOf(item.sig)]),
      });
      members.set(id, [partner]);
      touched.add(id);
      index(node);
      return { articleId: item.id, action: "create", clusterId: id, partnerId: partner.id, score: pick.score };
    }
  };

  return { assign, clusters };
}
