import { describe, expect, it } from "vitest";
import { ClusterEngine, assignClusters } from "../../lib/story-clustering/engine";
import { computeStorySig } from "../../lib/story-clustering/normalize";
import { CONFIG, flatIdf, makeIdf, prepare, scorePair } from "../../lib/story-clustering/similarity";
import type { ClusterState, PendingItem, StorySig, WindowItem } from "../../lib/story-clustering/types";
import { NOW, allItems, evaluate, groups, holdoutGroups } from "./story-fixtures";

const H = 3_600_000;

function sig(tokens: string[], extra: Partial<StorySig> = {}): StorySig {
  return { v: 1, t: tokens, e: [], l: [], q: 1, ...extra };
}
const words = (from: number, to: number) => Array.from({ length: to - from + 1 }, (_, i) => `wort${String.fromCharCode(97 + ((from + i) % 26))}${from + i}x`);

describe("fixture headlines (K1.7)", () => {
  it("global run over every group + filler: each `same` group is one cluster, nothing else joins", () => {
    const items = allItems();
    const { decisions } = assignClusters(items, [], []);
    const ev = evaluate(items, decisions);
    const failing = [...ev.perGroup].filter(([, e]) => !e.ok).map(([g]) => g);
    expect(failing).toEqual([]);
    expect(ev.fp).toBe(0);
    expect(ev.fn).toBe(0);
    // apple-xlang is the same story as iphone17: one cluster of 5 sources
    expect([...ev.clusters.values()].some((m) => m.length === 5)).toBe(true);
  });

  it("every group on its own (+ filler) gives the same verdict", () => {
    for (const g of groups) {
      const items = allItems([g]);
      const { decisions } = assignClusters(items, [], []);
      const ev = evaluate(items, decisions);
      expect(ev.perGroup.get(g.id)!.ok, g.id).toBe(true);
      expect(ev.fp, g.id).toBe(0);
    }
  });

  it("holdout groups (written after tuning, never used for it): zero false merges", () => {
    const items = allItems([...groups, ...holdoutGroups]);
    const { decisions } = assignClusters(items, [], []);
    const ev = evaluate(items, decisions);
    expect(ev.fp).toBe(0);
    expect(ev.precision).toBe(1);
    // recall is reported in docs/story-clustering.md; guard against regressions only
    expect(ev.recall).toBeGreaterThanOrEqual(0.8);
  });

  it("score margin: every same-story pair clears the threshold, every other pair stays below with room to spare", () => {
    const items = allItems();
    const df = new Map<string, number>();
    for (const i of items) if (!i.sig.x) for (const t of i.sig.t) df.set(t, (df.get(t) ?? 0) + 1);
    const idf = makeIdf(df, items.filter((i) => !i.sig.x).length);
    let minPos = Infinity;
    let maxNeg = -Infinity;
    for (let i = 0; i < items.length; i++) {
      for (let j = i + 1; j < items.length; j++) {
        const a = items[i];
        const b = items[j];
        if (a.feedId === b.feedId || a.sig.x || b.sig.x) continue;
        const s = scorePair(prepare(a.sig), prepare(b.sig), idf, Math.abs(a.publishedAt - b.publishedAt));
        if (!s?.gate) continue;
        if (a.story === b.story && a.expect === "same") minPos = Math.min(minPos, s.score);
        else maxNeg = Math.max(maxNeg, s.score);
      }
    }
    expect(minPos).toBeGreaterThanOrEqual(CONFIG.joinThreshold);
    expect(maxNeg).toBeLessThan(CONFIG.joinThreshold - 0.02);
  });

  it.skipIf(!process.env.STORY_REPORT)("report (STORY_REPORT=1)", () => {
    const lines: string[] = [];
    for (const [label, sel] of [["main", groups], ["holdout", [...groups, ...holdoutGroups]]] as const) {
      const items = allItems(sel as typeof groups);
      const { decisions } = assignClusters(items, [], []);
      const ev = evaluate(items, decisions);
      lines.push(`${label}: items=${items.length} TP=${ev.tp} FP=${ev.fp} FN=${ev.fn} precision=${ev.precision.toFixed(3)} recall=${ev.recall.toFixed(3)}`);
      for (const [g, e] of ev.perGroup) if (g !== "filler") lines.push(`  ${e.ok ? "ok " : "BAD"} ${g} (${e.expect}) -> ${e.clusters.join(",")}`);
    }
    console.log(lines.join("\n"));
  });
});

describe("engine properties", () => {
  it("is deterministic: shuffled pending input yields identical decisions", () => {
    const items = allItems();
    const a = assignClusters(items, [], []);
    const shuffled = [...items].sort((x, y) => (x.id < y.id ? 1 : -1));
    const b = assignClusters(shuffled, [], []);
    expect(b.decisions).toEqual(a.decisions);
    expect(b.clusters).toEqual(a.clusters);
  });

  it("is incremental-safe: batches of 7 give the same decisions as one shot", async () => {
    const { ClusterEngine } = await import("../../lib/story-clustering/engine");
    const items = allItems();
    const oneShot = assignClusters(items, [], []).decisions;
    const engine = new ClusterEngine(items, [], []);
    const stepped = [];
    while (engine.remaining > 0) stepped.push(...engine.step(7));
    expect(stepped).toEqual(oneShot);
  });

  it("does not touch already-processed articles when nothing is pending (idempotent)", () => {
    const items = allItems();
    const first = assignClusters(items, [], []);
    const clusterOf = new Map<string, string>();
    for (const d of first.decisions) {
      if (d.action === "create") {
        clusterOf.set(d.articleId, d.clusterId!);
        clusterOf.set(d.partnerId!, d.clusterId!);
      } else if (d.action === "join") clusterOf.set(d.articleId, d.clusterId!);
    }
    const window: WindowItem[] = items.map((i) => ({ id: i.id, feedId: i.feedId, publishedAt: i.publishedAt, clusterId: clusterOf.get(i.id) ?? null, sig: i.sig }));
    const second = assignClusters([], window, first.clusters);
    expect(second.decisions).toEqual([]);
    expect(second.clusters).toEqual([]);
  });

  it("drift guard: a chain A~B~C~D~… stops growing once newcomers no longer resemble the lead", () => {
    // each article shares 5 of 6 tokens with its neighbour, 4 with the next-but-one …
    const feedOf = (i: number) => `feed${i}`;
    const chain: PendingItem[] = Array.from({ length: 8 }, (_, i) => ({
      id: `c${i}`,
      feedId: feedOf(i),
      publishedAt: NOW - (8 - i) * H,
      sig: sig(words(i, i + 5), { q: 1 - i * 0.01 }),
    }));
    const { decisions } = assignClusters(chain, [], []);
    const clusterOf = new Map<string, string>();
    for (const d of decisions) {
      if (d.action === "create") {
        clusterOf.set(d.articleId, d.clusterId!);
        clusterOf.set(d.partnerId!, d.clusterId!);
      } else if (d.action === "join") clusterOf.set(d.articleId, d.clusterId!);
    }
    const last = chain[chain.length - 1];
    const prev = chain[chain.length - 2];
    // Without the guard the tail would join: it scores ≥ threshold against its direct predecessor …
    expect(scorePair(prepare(last.sig), prepare(prev.sig), flatIdf, H)!.join).toBe(true);
    // … but it no longer resembles the first cluster's lead, so it never ends up there.
    const firstCluster = clusterOf.get("c0");
    expect(firstCluster).toBeDefined();
    expect(clusterOf.get(last.id)).not.toBe(firstCluster);
    expect([...clusterOf.values()].filter((c) => c === firstCluster).length).toBeLessThan(chain.length);
    expect(scorePair(prepare(last.sig), prepare(chain[0].sig), flatIdf, 8 * H)!.score).toBeLessThan(CONFIG.driftThreshold);
  });

  it("drift anchor: a chain of lead swaps cannot leave the story the cluster started as", () => {
    // Every newcomer is a better lead than the previous one (q rises) and resembles its predecessor, so
    // a lead-only guard is satisfied forever. The anchor (first two members) still stops the walk.
    const chain: PendingItem[] = Array.from({ length: 8 }, (_, i) => ({
      id: `c${i}`,
      feedId: `feed${i}`,
      publishedAt: NOW - (8 - i) * H,
      sig: sig(words(i, i + 5), { q: 1 + i * 0.1 }),
    }));
    const head = new ClusterEngine(chain.slice(0, 4), [], []);
    head.step(Infinity);
    const clusters = head.drainTouched();
    expect(clusters).toHaveLength(1);
    expect(clusters[0].size).toBe(4);
    expect(clusters[0].leadArticleId).toBe("c3"); // swapped three times
    expect(clusters[0].sig.anchor?.length).toBe(2);
    const window: WindowItem[] = chain.slice(0, 4).map((c) => ({ id: c.id, feedId: c.feedId, publishedAt: c.publishedAt, clusterId: clusters[0].id, sig: c.sig }));
    const tail = chain.slice(4);

    // Control: the same cluster without an anchor (clusters written before the field existed) keeps absorbing the chain.
    const legacy = structuredClone(clusters[0]);
    delete legacy.sig.anchor;
    const control = assignClusters(tail, window, [legacy]).decisions;
    expect(control.filter((d) => d.action === "join")).toHaveLength(tail.length);

    // With the anchor the walk stops: the lead still matches c4's neighbour, but nothing of c0/c1 is left in c5+.
    const anchored = assignClusters(tail, window, clusters).decisions;
    const joined = anchored.filter((d) => d.action === "join").map((d) => d.articleId);
    expect(joined.length).toBeLessThan(tail.length);
    expect(joined).not.toContain(tail[tail.length - 1].id);
    // … and the cut is exactly where the newcomer no longer resembles either anchor member.
    for (const item of tail) {
      const vs = clusters[0].sig.anchor!.map((a) => scorePair(prepare(item.sig), prepare(a), flatIdf, 8 * H)?.score ?? 0);
      const inCluster = joined.includes(item.id);
      if (!inCluster) expect(Math.max(...vs)).toBeLessThan(CONFIG.driftThreshold);
    }
  });

  it("size cap: a full cluster (50) accepts no further sources, 49 still does", () => {
    const lead: WindowItem = { id: "lead", feedId: "f0", publishedAt: NOW - H, clusterId: "cl", sig: sig(["alpha", "beta", "gamma", "delta"]) };
    const cluster = (size: number): ClusterState => ({
      id: "cl",
      leadArticleId: "lead",
      size,
      feedIds: ["f0"],
      firstSeenAt: lead.publishedAt,
      lastSeenAt: lead.publishedAt,
      sig: { t: { alpha: 1, beta: 1, gamma: 1, delta: 1 }, e: [], lead: lead.sig },
    });
    const newcomer: PendingItem = { id: "new", feedId: "f1", publishedAt: NOW, sig: sig(["alpha", "beta", "gamma", "delta"]) };
    expect(assignClusters([newcomer], [lead], [cluster(50)]).decisions[0].action).toBe("single");
    expect(assignClusters([newcomer], [lead], [cluster(49)]).decisions[0]).toMatchObject({ action: "join", clusterId: "cl" });
  });

  it("window edge: 47 h apart joins, 49 h apart does not", () => {
    const base: WindowItem = { id: "old", feedId: "f0", publishedAt: NOW - 47 * H, clusterId: null, sig: sig(["alpha", "beta", "gamma", "delta"]) };
    const at = (hours: number): PendingItem => ({ id: "new", feedId: "f1", publishedAt: NOW - 47 * H + hours * H, sig: sig(["alpha", "beta", "gamma", "delta"]) });
    expect(assignClusters([at(47)], [base], []).decisions[0].action).toBe("create");
    expect(assignClusters([at(49)], [base], []).decisions[0].action).toBe("single");
  });

  it("same-feed pairs never join, excluded signatures are skipped", () => {
    const a: WindowItem = { id: "a", feedId: "f0", publishedAt: NOW - H, clusterId: null, sig: sig(["alpha", "beta", "gamma", "delta"]) };
    const sameFeed: PendingItem = { id: "b", feedId: "f0", publishedAt: NOW, sig: sig(["alpha", "beta", "gamma", "delta"]) };
    expect(assignClusters([sameFeed], [a], []).decisions[0].action).toBe("single");
    const excluded: PendingItem = { id: "c", feedId: "f1", publishedAt: NOW, sig: sig(["alpha", "beta", "gamma", "delta"], { x: 1 }) };
    expect(assignClusters([excluded], [a], []).decisions[0].action).toBe("skip");
  });

  it("a cluster never holds two articles of one feed", () => {
    const items = allItems();
    const { decisions } = assignClusters(items, [], []);
    const feedOf = new Map(items.map((i) => [i.id, i.feedId]));
    const byCluster = new Map<string, string[]>();
    for (const d of decisions) {
      if (!d.clusterId) continue;
      byCluster.set(d.clusterId, [...(byCluster.get(d.clusterId) ?? []), feedOf.get(d.articleId)!, ...(d.partnerId ? [feedOf.get(d.partnerId)!] : [])]);
    }
    for (const feeds of byCluster.values()) expect(new Set(feeds).size).toBe(feeds.length);
  });

  it("lead pick: higher quality wins, earliest breaks ties", () => {
    const a: WindowItem = { id: "a", feedId: "f0", publishedAt: NOW - 3 * H, clusterId: null, sig: sig(["alpha", "beta", "gamma", "delta"], { q: 1 }) };
    const better: PendingItem = { id: "b", feedId: "f1", publishedAt: NOW - H, sig: sig(["alpha", "beta", "gamma", "delta"], { q: 3 }) };
    const tie: PendingItem = { id: "c", feedId: "f2", publishedAt: NOW, sig: sig(["alpha", "beta", "gamma", "delta"], { q: 3 }) };
    const { clusters } = assignClusters([better, tie], [a], []);
    expect(clusters[0].leadArticleId).toBe("b");
    expect(clusters[0].size).toBe(3);
  });
});

describe("hard negatives (contradictions, series, same entity)", () => {
  const sigOf = (title: string) => computeStorySig({ title, link: "https://x.test/a", feedName: "x", feedPriority: "main" });
  const pending = (id: string, feedId: string, title: string, hoursAgo = 2): PendingItem => ({ id, feedId, publishedAt: NOW - hoursAgo * H, sig: sigOf(title) });
  const clusteredTogether = (a: PendingItem, b: PendingItem) => assignClusters([a, b], [], []).decisions.some((d) => d.action === "create");

  it.each([
    ["DAX up vs down", "DAX steigt auf Rekordhoch über 19.000 Punkte", "DAX fällt unter 18.000 Punkte: Anleger verunsichert"],
    ["same wording, one flipped direction", "DAX steigt über 19.000 Punkte: Anleger erleichtert", "DAX fällt über 19.000 Punkte: Anleger erleichtert"],
    ["Zinssenkung vs Zinserhöhung", "EZB beschließt Zinssenkung um 0,25 Prozentpunkte", "EZB beschließt Zinserhöhung um 0,25 Prozentpunkte"],
    ["cuts vs raises", "Fed cuts rates by 25 basis points", "Fed raises rates by 25 basis points"],
    ["im Plus vs im Minus", "Börse am Montag: Dax startet im Plus", "Börse am Dienstag: Dax startet im Minus"],
    ["recurring series, other weekday", "Wetter am Montag: Sonne und bis zu 20 Grad", "Wetter am Dienstag: Sonne und bis zu 20 Grad"],
    ["same entity, different event", "Tesla ruft 120.000 Fahrzeuge wegen Bremsproblemen zurück", "Tesla eröffnet neue Gigafactory in Indien"],
  ])("%s never merge", (_label, a, b) => {
    expect(clusteredTogether(pending("a", "f0", a), pending("b", "f1", b))).toBe(false);
  });

  it("controls: the same story reworded, and headlines naming both directions, still merge", () => {
    expect(clusteredTogether(pending("a", "f0", "EZB beschließt Zinssenkung um 0,25 Prozentpunkte"), pending("b", "f1", "EZB senkt Leitzins: Zinssenkung um 0,25 Prozentpunkte"))).toBe(true);
    expect(clusteredTogether(pending("a", "f0", "Wetter am Montag: Sonne und bis zu 20 Grad"), pending("b", "f1", "Wetter am Montag: Sonne, bis zu 20 Grad"))).toBe(true);
    expect(clusteredTogether(pending("a", "f0", "DAX steigt nach Zinssenkung auf Rekordhoch über 19.000 Punkte"), pending("b", "f1", "Zinssenkung: DAX fällt nach Rekordhoch nicht, bleibt über 19.000 Punkte"))).toBe(true);
  });
});
