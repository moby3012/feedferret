// K2 input selection (.pm/spec-ai-briefing.md §K2.3): window, candidates,
// story units (K1 clusters collapsed), ranking, top/brief split. Every query
// is scoped to `userId`; scope ids are ownership-checked by the caller
// (`resolveBriefingScope`).
import { createHash } from "node:crypto";
import { db } from "@/lib/db";
import { stripHtml } from "@/lib/ai-summary";
import { buildViewScope } from "@/server/articles/view-scope";
import type { Scope } from "@/features/articles/scope";
import { briefingScopeKey, type BriefingScope } from "./types";

export const PROMPT_VERSION = 1;
export const MAX_CANDIDATES = 600;
export const MAX_TOP = 12;
export const MAX_BRIEF = 18;
export const MIN_UNITS = 3;
export const EXCERPT_CHARS = 350;

const H = 3_600_000;
const DEFAULT_WINDOW_MS = 24 * H;
const MAX_WINDOW_MS = 72 * H;
const MIN_WINDOW_MS = 1 * H;

export interface StoryUnit {
  leadId: string;
  memberIds: string[];
  /** Feed name of each member (parallel to `memberIds`). */
  memberFeedNames: string[];
  feedIds: string[];
  feedNames: string[];
  title: string;
  excerpt: string;
  publishedAt: Date;
  score: number;
}

export interface BriefingInput {
  scopeKey: string;
  windowStart: Date;
  windowEnd: Date;
  lang: string;
  top: StoryUnit[];
  brief: StoryUnit[];
  totalUnread: number;
  totalStories: number;
}

/** Ownership-checked scope → the list scope it briefs. `null` = not the user's (404). */
export async function resolveBriefingScope(userId: string, scope: BriefingScope): Promise<Scope | null> {
  if (scope.kind === "new") return { kind: "all" };
  if (scope.kind === "category") {
    const owned = await db.category.findFirst({ where: { id: scope.id, userId }, select: { id: true } });
    return owned ? { kind: "category", id: scope.id } : null;
  }
  const owned = await db.label.findFirst({ where: { id: scope.id, userId }, select: { id: true } });
  return owned ? { kind: "label", id: scope.id } : null;
}

/** `start` = end of the latest SEEN briefing of the scope, else now−24 h; clamped to [now−72 h, now−1 h]. */
export function briefingWindow(lastSeenEnd: Date | null, now: Date): { start: Date; end: Date } {
  const raw = lastSeenEnd ? lastSeenEnd.getTime() : now.getTime() - DEFAULT_WINDOW_MS;
  const start = Math.min(now.getTime() - MIN_WINDOW_MS, Math.max(now.getTime() - MAX_WINDOW_MS, raw));
  return { start: new Date(start), end: now };
}

export const PRIORITY_WEIGHT: Record<string, number> = { important: 1.5, main: 1.0, category: 0.6, feed: 0.6 };

export interface ScoreSignals {
  feedCount: number;
  priority: string;
  engagement: number; // 0..1, normalized
  ageHours: number;
  hit: boolean;
  clickbait: boolean;
}

export function scoreUnit(s: ScoreSignals): number {
  return (
    1.0 * Math.log2(1 + s.feedCount) +
    (PRIORITY_WEIGHT[s.priority] ?? 1.0) +
    0.8 * s.engagement +
    0.5 * Math.exp(-Math.max(0, s.ageHours) / 12) +
    (s.hit ? 0.3 : 0) -
    (s.clickbait ? 0.5 : 0)
  );
}

// ─── Feed engagement, memoized per user (6 h, ≤500 users) ──────────────────

const ENG_TTL_MS = 6 * H;
const ENG_MAX_USERS = 500;
const engagementCache = new Map<string, { at: number; byFeed: Map<string, number> }>();

export function clearEngagementCache() {
  engagementCache.clear();
}

/** eng(feed) = (3·starred30 + 2·later30 + 1) / (total30 + 5), normalized to the max over feeds. */
export async function feedEngagement(userId: string, now: Date): Promise<Map<string, number>> {
  const hit = engagementCache.get(userId);
  if (hit && now.getTime() - hit.at < ENG_TTL_MS) return hit.byFeed;
  const since = new Date(now.getTime() - 30 * 24 * H);
  const [totals, saved] = await Promise.all([
    db.article.groupBy({ by: ["feedId"], where: { userId, publishedAt: { gte: since } }, _count: { _all: true } }),
    db.article.groupBy({
      by: ["feedId", "isStarred", "isReadLater"],
      where: { userId, publishedAt: { gte: since }, OR: [{ isStarred: true }, { isReadLater: true }] },
      _count: { _all: true },
    }),
  ]);
  const starred = new Map<string, number>();
  const later = new Map<string, number>();
  for (const row of saved) {
    if (row.isStarred) starred.set(row.feedId, (starred.get(row.feedId) ?? 0) + row._count._all);
    if (row.isReadLater) later.set(row.feedId, (later.get(row.feedId) ?? 0) + row._count._all);
  }
  const raw = new Map<string, number>();
  let max = 0;
  for (const row of totals) {
    const v = (3 * (starred.get(row.feedId) ?? 0) + 2 * (later.get(row.feedId) ?? 0) + 1) / (row._count._all + 5);
    raw.set(row.feedId, v);
    max = Math.max(max, v);
  }
  const byFeed = new Map<string, number>();
  for (const [feedId, v] of raw) byFeed.set(feedId, max > 0 ? v / max : 0);
  if (engagementCache.size >= ENG_MAX_USERS && !engagementCache.has(userId)) {
    const oldest = engagementCache.keys().next().value;
    if (oldest !== undefined) engagementCache.delete(oldest);
  }
  engagementCache.delete(userId);
  engagementCache.set(userId, { at: now.getTime(), byFeed });
  return byFeed;
}

export function excerptOf(text: string | null | undefined, max = EXCERPT_CHARS): string {
  const plain = stripHtml(text ?? "");
  return plain.length > max ? `${plain.slice(0, max - 1).trimEnd()}…` : plain;
}

/** Language name for the prompt: `aiSummaryLanguage` unless "same", else the UI language. */
export function briefingLanguage(aiSummaryLanguage: string | null | undefined, uiLanguage: string | null | undefined): string {
  const lang = aiSummaryLanguage && aiSummaryLanguage !== "same" ? aiSummaryLanguage : uiLanguage || "en";
  return lang.slice(0, 16);
}

type CandidateRow = {
  id: string;
  title: string;
  cleanTitle: string | null;
  isClickbait: boolean | null;
  excerpt: string | null;
  aiSummary: string | null;
  publishedAt: Date;
  clusterId: string | null;
  feedId: string;
  feed: { name: string; priority: string };
};

/**
 * Candidates the reader marked (a user label — never an AI auto-tag) or a
 * keyword alert / rule hit notified about: one grouped query per signal,
 * restricted to the candidate ids (index-backed, no whole-table counts).
 */
async function userSignalHits(userId: string, ids: string[]): Promise<Set<string>> {
  if (ids.length === 0) return new Set();
  const [labels, alerts] = await Promise.all([
    db.articleLabel.groupBy({ by: ["articleId"], where: { userId, articleId: { in: ids }, source: "user" } }),
    db.notification.groupBy({ by: ["articleId"], where: { userId, articleId: { in: ids }, type: { in: ["keyword_alert", "rule_match"] } } }),
  ]);
  const hits = new Set<string>();
  for (const row of labels) hits.add(row.articleId);
  for (const row of alerts) if (row.articleId) hits.add(row.articleId);
  return hits;
}

export interface SelectOptions {
  now?: Date;
}

/**
 * Builds the briefing input of one scope (≤ 7 queries + 2 memoized).
 * `scope` must already be ownership-checked (see `resolveBriefingScope`).
 */
export async function selectBriefingInput(userId: string, scope: BriefingScope, listScope: Scope, o: SelectOptions = {}): Promise<BriefingInput> {
  const now = o.now ?? new Date();
  const scopeKey = briefingScopeKey(scope);
  const [lastSeen, user, view] = await Promise.all([
    db.briefing.findFirst({ where: { userId, scopeKey, seenAt: { not: null } }, orderBy: { windowEnd: "desc" }, select: { windowEnd: true } }),
    db.user.findUnique({ where: { id: userId }, select: { aiSummaryLanguage: true, uiLanguage: true, storyClustering: true } }),
    buildViewScope(userId, listScope),
  ]);
  const window = briefingWindow(lastSeen?.windowEnd ?? null, now);
  const lang = briefingLanguage(user?.aiSummaryLanguage, user?.uiLanguage);

  const where = {
    AND: [
      view.where,
      { isRead: false, isDuplicate: false, isSpoiler: false },
      // K3: sponsored content never enters a briefing (null = unknown → kept).
      // (Explicit null branch: SQL `NOT (x = true)` would also drop NULL rows.)
      { OR: [{ isSponsored: null }, { isSponsored: false }] },
      { feed: { priority: { not: "hidden" } } },
      { OR: [{ createdAt: { gte: window.start } }, { publishedAt: { gte: window.start } }] },
    ],
  };
  const rows: CandidateRow[] = await db.article.findMany({
    where,
    orderBy: [{ publishedAt: "desc" }, { id: "desc" }],
    take: MAX_CANDIDATES,
    select: {
      id: true,
      title: true,
      cleanTitle: true,
      isClickbait: true,
      excerpt: true,
      aiSummary: true,
      publishedAt: true,
      clusterId: true,
      feedId: true,
      feed: { select: { name: true, priority: true } },
    },
  });

  // Group into story units: one per K1 cluster, singletons on their own. With
  // story clustering switched off for the user, every article is its own unit
  // (stale clusterIds from before the switch are ignored).
  const clustering = user?.storyClustering ?? true;
  if (!clustering) for (const row of rows) row.clusterId = null;
  const groups = new Map<string, CandidateRow[]>();
  for (const row of rows) {
    const key = row.clusterId ? `c:${row.clusterId}` : `a:${row.id}`;
    const list = groups.get(key);
    if (list) list.push(row);
    else groups.set(key, [row]);
  }
  const clusterIds = [...new Set(rows.map((r) => r.clusterId).filter((id): id is string => !!id))];
  const [clusters, engagement, hits] = await Promise.all([
    clusterIds.length
      ? db.storyCluster.findMany({ where: { userId, id: { in: clusterIds } }, select: { id: true, leadArticleId: true } })
      : Promise.resolve([] as { id: string; leadArticleId: string }[]),
    feedEngagement(userId, now),
    userSignalHits(userId, rows.map((r) => r.id)),
  ]);
  const leadOf = new Map(clusters.map((c) => [c.id, c.leadArticleId]));

  const units: (StoryUnit & { leadRow: CandidateRow })[] = [];
  for (const members of groups.values()) {
    const clusterLead = members[0].clusterId ? leadOf.get(members[0].clusterId) : undefined;
    const lead = members.find((m) => m.id === clusterLead) ?? [...members].sort((a, b) => rank(b) - rank(a))[0];
    const feedIds = [...new Set(members.map((m) => m.feedId))];
    const feedNames = [...new Set([lead, ...members].map((m) => m.feed.name))];
    const newest = members.reduce((t, m) => Math.max(t, m.publishedAt.getTime()), 0);
    const priority = members.reduce((best, m) => ((PRIORITY_WEIGHT[m.feed.priority] ?? 1) > (PRIORITY_WEIGHT[best] ?? 1) ? m.feed.priority : best), lead.feed.priority);
    const clickbait = lead.isClickbait === true;
    const score = scoreUnit({
      feedCount: feedIds.length,
      priority,
      engagement: Math.max(...feedIds.map((f) => engagement.get(f) ?? 0)),
      ageHours: (now.getTime() - Math.min(newest, now.getTime())) / H,
      hit: members.some((m) => hits.has(m.id)),
      clickbait,
    });
    const ordered = [lead, ...members.filter((m) => m.id !== lead.id)];
    units.push({
      leadId: lead.id,
      memberIds: ordered.map((m) => m.id),
      memberFeedNames: ordered.map((m) => m.feed.name),
      feedIds,
      feedNames,
      title: (clickbait && lead.cleanTitle ? lead.cleanTitle : lead.title).trim(),
      excerpt: "",
      publishedAt: new Date(newest),
      score,
      leadRow: lead,
    });
  }
  units.sort((a, b) => b.score - a.score || b.publishedAt.getTime() - a.publishedAt.getTime() || (a.leadId < b.leadId ? -1 : 1));
  const chosen = units.slice(0, MAX_TOP + MAX_BRIEF);

  // Excerpts only for the units that can carry one (top); content is fetched
  // only for leads without excerpt / AI summary.
  const top = chosen.slice(0, MAX_TOP);
  const needContent = top.filter((u) => !u.leadRow.excerpt?.trim() && !u.leadRow.aiSummary?.trim()).map((u) => u.leadId);
  const contents = needContent.length
    ? await db.article.findMany({ where: { userId, id: { in: needContent } }, select: { id: true, content: true } })
    : [];
  const contentOf = new Map(contents.map((c) => [c.id, c.content.slice(0, 2000)]));
  for (const u of top) u.excerpt = excerptOf(u.leadRow.excerpt?.trim() || u.leadRow.aiSummary?.trim() || contentOf.get(u.leadId) || "");

  const strip = ({ leadRow: _leadRow, ...unit }: StoryUnit & { leadRow: CandidateRow }): StoryUnit => unit;
  return {
    scopeKey,
    windowStart: window.start,
    windowEnd: window.end,
    lang,
    top: top.map(strip),
    brief: chosen.slice(MAX_TOP).map(strip),
    totalUnread: rows.length,
    totalStories: units.length,
  };
}

function rank(row: CandidateRow): number {
  return (PRIORITY_WEIGHT[row.feed.priority] ?? 1) * 10 + (row.excerpt ? 1 : 0) - (row.isClickbait ? 2 : 0);
}

/** Stable identity of an input (story ids + language + prompt version) → cache key part. */
export function inputHash(input: BriefingInput): string {
  const units = [...input.top, ...input.brief].map((u) => [u.leadId, [...u.memberIds].sort()]);
  return createHash("sha256").update(JSON.stringify({ v: PROMPT_VERSION, lang: input.lang, units })).digest("hex").slice(0, 32);
}

/** All article ids an input covers (stale detection against a cached briefing). */
export function inputArticleIds(input: BriefingInput): string[] {
  return [...input.top, ...input.brief].flatMap((u) => u.memberIds);
}
