/**
 * FreshRSS article export importer.
 *
 * FreshRSS exports starred and labelled articles (and, per feed, recent articles)
 * as a Google-Reader-like JSON envelope — see `app/views/helpers/export/articles.phtml`
 * and `Entry::toGReader('freshrss')` upstream:
 *
 *   { "id": "user/<name>/state/org.freshrss/starred", "title": …, "author": …,
 *     "items": [ { "frss:id": …, "id": "tag:google.com,2005:reader/item/<hex>",
 *                  "guid": …, "crawlTimeMsec": …, "published": <unix s>, "title": …,
 *                  "canonical": [{href}], "alternate": [{href,type}],
 *                  "categories": ["user/-/state/com.google/read|unread|starred",
 *                                 "user/-/label/<name>", …],
 *                  "origin": { "streamId", "htmlUrl", "title", "feedUrl" },
 *                  "content": { "content": "<html>" }, "enclosure": [{href,type,length}],
 *                  "author": … } ] }
 *
 * Identity: an article is the same article when its origin feed (by URL) and its
 * `guid` / link match, using the exact `dedupeKey` the sync pipeline computes, so a
 * later feed sync does not create a second copy. Re-importing never clears state:
 * read/starred are OR-merged and labels only added.
 *
 * `starred_*.json` does NOT mean every item is starred (label-only items are in
 * there too); stars come from the `…/starred` category only.
 */

import { createHash } from "node:crypto";
import { connectorFeedUrlErrorWith, getConnectorSecretRules, stripConnectorSecretsWith } from "@/lib/connector-secrets";
import type { PrismaClient } from "@prisma/client";
import { db } from "@/lib/db";
import { allocateExternalIds } from "@/lib/external-id-store";
import { buildDedupeKey } from "@/lib/dedupe-key";
import { computeContentHash } from "@/lib/content-hash";
import { computeArticleMeta } from "@/lib/article-kind";
import { getSanitizer } from "@/lib/sanitize-html";
import { MAX_FEED_URL_LENGTH, MAX_LABEL_NAME, validateFeedUrl } from "@/lib/validation";
import type { ImportIssue } from "./opml-import";

export const ARTICLE_IMPORT_CHUNK_SIZE = 200;
/** Hard ceiling on article items accepted in one migration run (all files together). */
export const MAX_IMPORT_ITEMS_PER_RUN = 500_000;
const MAX_REPORTED_ERRORS = 50;
const MAX_GUID_LENGTH = 2048;
const MAX_TITLE_LENGTH = 1000;
const MAX_CONTENT_CHARS = 2_000_000;

export interface FrssEnclosure { href: string; type: string; length?: number }

export interface NormalizedFrssItem {
  guid: string | null;
  link: string;
  title: string;
  author: string | null;
  content: string;
  publishedAt: Date;
  /** Discovery time in FreshRSS (`crawlTimeMsec`), kept as `createdAt`. */
  discoveredAt: Date | null;
  isRead: boolean;
  isStarred: boolean;
  labels: string[];
  enclosures: FrssEnclosure[];
  feedUrl: string;
  feedTitle: string | null;
  feedHtmlUrl: string | null;
  /** True when the export carried no usable feed URL and a placeholder URL was synthesised. */
  syntheticFeed: boolean;
}

export interface ArticleImportCounts {
  total: number;
  created: number;
  /** Existing articles whose state/labels/enclosures were extended. */
  updated: number;
  unchanged: number;
  skipped: number;
  labelsCreated: number;
  labelAssignments: number;
  orphanFeedsCreated: number;
  starred: number;
  read: number;
}

export interface ArticleImportReport {
  dryRun: boolean;
  counts: ArticleImportCounts;
  errors: string[];
  errorCount: number;
  orphanFeeds: string[];
  issues: ImportIssue[];
}

export function emptyArticleCounts(): ArticleImportCounts {
  return { total: 0, created: 0, updated: 0, unchanged: 0, skipped: 0, labelsCreated: 0, labelAssignments: 0, orphanFeedsCreated: 0, starred: 0, read: 0 };
}

export function mergeArticleReports(a: ArticleImportReport, b: ArticleImportReport): ArticleImportReport {
  const counts = emptyArticleCounts();
  for (const key of Object.keys(counts) as (keyof ArticleImportCounts)[]) counts[key] = a.counts[key] + b.counts[key];
  const orphanFeeds = Array.from(new Set([...a.orphanFeeds, ...b.orphanFeeds]));
  return {
    dryRun: a.dryRun,
    counts,
    errors: [...a.errors, ...b.errors].slice(0, MAX_REPORTED_ERRORS),
    errorCount: a.errorCount + b.errorCount,
    orphanFeeds,
    issues: [...a.issues, ...b.issues],
  };
}

export class FreshRssJsonError extends Error {}

// ── Parsing ──────────────────────────────────────────────────────────────────

export function parseFreshRssArticleJson(text: string): { header: { id?: string; title?: string; author?: string }; items: unknown[] } {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text.charCodeAt(0) === 0xfeff ? text.slice(1) : text);
  } catch (error) {
    throw new FreshRssJsonError(`Not valid JSON: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed) || !Array.isArray((parsed as { items?: unknown }).items)) {
    throw new FreshRssJsonError("Not a FreshRSS article export (expected an object with an 'items' array)");
  }
  const envelope = parsed as { id?: unknown; title?: unknown; author?: unknown; items: unknown[] };
  const str = (value: unknown) => (typeof value === "string" ? value : undefined);
  return { header: { id: str(envelope.id), title: str(envelope.title), author: str(envelope.author) }, items: envelope.items };
}

/** Over-long identifiers are replaced by a stable hash so they stay usable as dedupe/external ids. */
function capGuid(guid: string | null): string | null {
  if (guid === null || guid.length <= MAX_GUID_LENGTH) return guid;
  return `sha256:${createHash("sha256").update(guid).digest("hex")}`;
}

const asString = (value: unknown): string | null => (typeof value === "string" && value.trim() ? value.trim() : null);

function firstHref(value: unknown): string | null {
  if (!Array.isArray(value)) return null;
  for (const entry of value) {
    const href = asString((entry as { href?: unknown } | null)?.href);
    if (href) return href;
  }
  return null;
}

function httpOrNull(url: string | null): string | null {
  return url && validateFeedUrl(url) === null ? url : null;
}

function toDate(value: unknown, unit: "s" | "ms" | "us"): Date | null {
  const n = typeof value === "string" ? Number(value) : typeof value === "number" ? value : NaN;
  if (!Number.isFinite(n) || n <= 0) return null;
  const ms = unit === "s" ? n * 1000 : unit === "us" ? n / 1000 : n;
  const date = new Date(ms > 1e14 ? ms / 1000 : ms);
  return Number.isNaN(date.getTime()) || date.getFullYear() < 1990 || date.getFullYear() > 2200 ? null : date;
}

const STATE_PREFIX = "user/-/state/";
const LABEL_PREFIX = "user/-/label/";

export function normalizeFreshRssItem(raw: unknown): NormalizedFrssItem {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new FreshRssJsonError("item is not an object");
  const item = raw as Record<string, unknown>;

  const guid = capGuid(asString(item.guid) ?? asString(item.id));
  const link = httpOrNull(firstHref(item.canonical)) ?? httpOrNull(firstHref(item.alternate)) ?? httpOrNull(guid) ?? "";
  const title = (asString(item.title) ?? "").slice(0, MAX_TITLE_LENGTH);
  if (!guid && !link && !title) throw new FreshRssJsonError("item has neither guid, link nor title");

  const categories = Array.isArray(item.categories) ? item.categories.filter((c): c is string => typeof c === "string") : [];
  const isRead = categories.includes(`${STATE_PREFIX}com.google/read`);
  const isStarred = categories.includes(`${STATE_PREFIX}com.google/starred`);
  const labels = Array.from(
    new Set(
      categories
        .filter((c) => c.startsWith(LABEL_PREFIX))
        .map((c) => c.slice(LABEL_PREFIX.length).trim())
        .filter((name) => name.length > 0 && name.length <= MAX_LABEL_NAME),
    ),
  );

  const contentField = (item.content ?? item.summary) as { content?: unknown } | undefined;
  const content = (typeof contentField?.content === "string" ? contentField.content : "").slice(0, MAX_CONTENT_CHARS);

  const enclosures: FrssEnclosure[] = [];
  for (const entry of Array.isArray(item.enclosure) ? item.enclosure : []) {
    const href = httpOrNull(asString((entry as { href?: unknown } | null)?.href));
    if (!href) continue;
    const length = Number((entry as { length?: unknown }).length);
    enclosures.push({
      href,
      type: asString((entry as { type?: unknown }).type) ?? "",
      ...(Number.isFinite(length) && length > 0 ? { length } : {}),
    });
  }

  const origin = (item.origin && typeof item.origin === "object" ? item.origin : {}) as Record<string, unknown>;
  const streamId = asString(origin.streamId);
  const declaredFeedUrl = asString(origin.feedUrl);
  const feedUrl = declaredFeedUrl && declaredFeedUrl.length <= MAX_FEED_URL_LENGTH && validateFeedUrl(declaredFeedUrl) === null
    ? declaredFeedUrl
    : `urn:freshrss:${(streamId ?? "feed/unknown").replace(/[^A-Za-z0-9/_.-]/g, "_").slice(0, 100)}`;

  const publishedAt = toDate(item.published, "s") ?? toDate(item.updated, "s") ?? toDate(item.crawlTimeMsec, "ms") ?? new Date(0);
  return {
    guid,
    link,
    title: title || "Untitled",
    author: asString(item.author),
    content,
    publishedAt,
    discoveredAt: toDate(item.crawlTimeMsec, "ms") ?? toDate(item.timestampUsec, "us"),
    isRead,
    isStarred,
    labels,
    enclosures,
    feedUrl,
    feedTitle: asString(origin.title),
    feedHtmlUrl: httpOrNull(asString(origin.htmlUrl)),
    syntheticFeed: feedUrl !== declaredFeedUrl,
  };
}

// ── Import ───────────────────────────────────────────────────────────────────

export interface DryRunRow { isRead: boolean; isStarred: boolean; hasEnclosures: boolean; labels: Set<string> }

export interface ImportArticlesOptions {
  dryRun?: boolean;
  chunkSize?: number;
  /** Feeds the same migration run subscribes to, by URL (dry-run only: they do not exist yet). */
  plannedFeeds?: ReadonlyMap<string, { unicityCriteria: string }>;
  /**
   * Dry-run only: what earlier files of the same run would have created, so overlapping
   * files (starred + per-feed) are counted exactly like the real run counts them.
   */
  dryRunLedger?: Map<string, DryRunRow>;
  fileName?: string;
  onProgress?: (progress: { phase: "articles"; file?: string; done: number; total: number }) => void;
}

type FeedRow = { id: string; url: string; unicityCriteria: string };

function fold(items: NormalizedFrssItem[], feedIdOf: (item: NormalizedFrssItem) => string, dedupeOf: (item: NormalizedFrssItem, feedId: string) => string) {
  const folded = new Map<string, NormalizedFrssItem & { feedId: string; dedupeKey: string }>();
  for (const item of items) {
    const feedId = feedIdOf(item);
    const dedupeKey = dedupeOf(item, feedId);
    const key = `${feedId}\u0000${dedupeKey}`;
    const prior = folded.get(key);
    if (!prior) {
      folded.set(key, { ...item, feedId, dedupeKey });
    } else {
      prior.isRead ||= item.isRead;
      prior.isStarred ||= item.isStarred;
      prior.labels = Array.from(new Set([...prior.labels, ...item.labels]));
      if (!prior.enclosures.length) prior.enclosures = item.enclosures;
    }
  }
  return [...folded.values()];
}

function orphanFeedName(item: NormalizedFrssItem): string {
  if (item.feedTitle) return item.feedTitle;
  try {
    return new URL(item.feedUrl).hostname;
  } catch {
    return item.feedUrl;
  }
}

export async function importFreshRssArticles(
  userId: string,
  rawItems: unknown[],
  options: ImportArticlesOptions = {},
): Promise<ArticleImportReport> {
  const dryRun = options.dryRun === true;
  const chunkSize = Math.max(1, options.chunkSize ?? ARTICLE_IMPORT_CHUNK_SIZE);
  const counts = emptyArticleCounts();
  const report: ArticleImportReport = { dryRun, counts, errors: [], errorCount: 0, orphanFeeds: [], issues: [] };
  const addError = (message: string) => {
    report.errorCount += 1;
    if (report.errors.length < MAX_REPORTED_ERRORS) report.errors.push(message);
  };
  counts.total = rawItems.length;

  const sanitizer = await getSanitizer();
  const feedCache = new Map<string, FeedRow>();
  const orphanSeen = new Set<string>();
  const labelCache = new Map<string, string>(); // name -> id
  const pendingLabelNames = new Set<string>(); // dry-run only

  // Connector feed URLs (N3): stored without the RSSHub key / changedetection
  // token; a URL that is not an allowed connector route (e.g. RSSHub's
  // /rsshub/transform/…) becomes an unfetchable placeholder instead.
  const secretRules = await getConnectorSecretRules();
  const storedUrlFor = (url: string) =>
    connectorFeedUrlErrorWith(secretRules, url)
      ? `urn:freshrss:blocked-connector-route:${createHash("sha256").update(url).digest("hex").slice(0, 16)}`
      : stripConnectorSecretsWith(secretRules, url);

  const resolveFeeds = async (items: NormalizedFrssItem[]) => {
    const missingUrls = Array.from(new Set(items.map((item) => item.feedUrl))).filter((url) => !feedCache.has(url));
    if (missingUrls.length) {
      const byStoredUrl = new Map(missingUrls.map((url) => [storedUrlFor(url), url] as const));
      const rows = await db.feed.findMany({ where: { userId, url: { in: Array.from(byStoredUrl.keys()) } }, select: { id: true, url: true, unicityCriteria: true } });
      for (const row of rows) feedCache.set(byStoredUrl.get(row.url) ?? row.url, row);
    }
    for (const item of items) {
      if (feedCache.has(item.feedUrl)) continue;
      const sameStored = Array.from(feedCache.entries()).find(([, row]) => row.url === storedUrlFor(item.feedUrl) && !row.id.startsWith("dry:"));
      if (sameStored) {
        feedCache.set(item.feedUrl, sameStored[1]);
        continue;
      }
      // Origin feed is not subscribed: keep its articles under an orphan feed. It is
      // muted so importing never triggers network fetches; the report lists it.
      const planned = options.plannedFeeds?.get(item.feedUrl);
      const isPlanned = planned !== undefined;
      if (!isPlanned && !orphanSeen.has(item.feedUrl)) {
        orphanSeen.add(item.feedUrl);
        counts.orphanFeedsCreated += 1;
        report.orphanFeeds.push(item.feedTitle ? `${item.feedTitle} (${item.feedUrl})` : item.feedUrl);
        if (item.syntheticFeed) {
          report.issues.push({ kind: "adapted", code: "feed-url-missing", subject: item.feedTitle ?? item.feedUrl, attribute: "origin.feedUrl", detail: "export has no usable feed URL; placeholder feed created (muted)" });
        }
      }
      if (dryRun) {
        feedCache.set(item.feedUrl, { id: `dry:${item.feedUrl}`, url: item.feedUrl, unicityCriteria: planned?.unicityCriteria ?? "id" });
        continue;
      }
      const created = await db.feed.create({
        data: {
          userId,
          url: storedUrlFor(item.feedUrl),
          name: orphanFeedName(item).slice(0, 200),
          htmlUrl: item.feedHtmlUrl,
          description: "Imported from FreshRSS (feed not subscribed in FeedFerret)",
          sourceType: "rss",
          autoMuted: !isPlanned || connectorFeedUrlErrorWith(secretRules, item.feedUrl) !== null,
        },
        select: { id: true, url: true, unicityCriteria: true },
      });
      feedCache.set(item.feedUrl, created);
    }
  };

  const resolveLabels = async (names: string[]) => {
    const missing = names.filter((name) => !labelCache.has(name) && !pendingLabelNames.has(name));
    if (!missing.length) return;
    const rows = await db.label.findMany({ where: { userId, name: { in: missing } }, select: { id: true, name: true } });
    for (const row of rows) labelCache.set(row.name, row.id);
    for (const name of missing) {
      if (labelCache.has(name)) continue;
      counts.labelsCreated += 1;
      if (dryRun) {
        pendingLabelNames.add(name);
        continue;
      }
      const created = await db.label.create({ data: { userId, name }, select: { id: true } });
      labelCache.set(name, created.id);
    }
  };

  const processChunk = async (rawChunk: unknown[]) => {
    const items: NormalizedFrssItem[] = [];
    for (const raw of rawChunk) {
      try {
        items.push(normalizeFreshRssItem(raw));
      } catch (error) {
        counts.skipped += 1;
        addError(`${options.fileName ?? "item"}: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
    if (!items.length) return;

    await resolveFeeds(items);
    const byFeedUrl = (item: NormalizedFrssItem) => feedCache.get(item.feedUrl)!;
    const folded = fold(
      items,
      (item) => byFeedUrl(item).id,
      (item, feedId) => {
        const feed = byFeedUrl(item);
        return buildDedupeKey(feed, { link: item.link, title: item.title, author: item.author, publishedAt: item.publishedAt }, item.guid || item.link || null) || feedId;
      },
    );
    await resolveLabels(Array.from(new Set(folded.flatMap((item) => item.labels))));

    const realFeedIds = Array.from(new Set(folded.map((item) => item.feedId).filter((id) => !id.startsWith("dry:"))));
    const existingRows = realFeedIds.length
      ? await db.article.findMany({
          where: {
            userId,
            feedId: { in: realFeedIds },
            OR: [
              { dedupeKey: { in: folded.map((item) => item.dedupeKey) } },
              { externalId: { in: folded.map((item) => item.guid).filter((g): g is string => !!g) } },
              { link: { in: folded.map((item) => item.link).filter(Boolean) } },
            ],
          },
          select: { id: true, feedId: true, dedupeKey: true, externalId: true, link: true, isRead: true, isStarred: true, enclosures: true, labels: { select: { labelId: true } } },
        })
      : [];
    const findExisting = (item: (typeof folded)[number]) =>
      existingRows.find((row) => row.feedId === item.feedId && row.dedupeKey === item.dedupeKey) ??
      (item.guid ? existingRows.find((row) => row.feedId === item.feedId && row.externalId === item.guid) : undefined) ??
      // Link is only a fallback identity for guid-less items vs. rows that never had an external id:
      // two distinct guids may legitimately share one link (and must stay two articles).
      (item.link && !item.guid ? existingRows.find((row) => row.feedId === item.feedId && row.link === item.link && !row.externalId) : undefined);

    type Create = { item: (typeof folded)[number]; row: Record<string, unknown> };
    const creates: Create[] = [];
    // One pending update per existing article, however many folded items resolved to it.
    const updatesById = new Map<string, { id: string; data: Record<string, unknown>; labelIds: Set<string>; names: Set<string> }>();
    const labelId = (name: string) => labelCache.get(name);

    for (const item of folded) {
      if (item.isStarred) counts.starred += 1;
      if (item.isRead) counts.read += 1;
      const existing = findExisting(item);
      if (!existing && dryRun) {
        // Same bookkeeping as the real run, against what earlier files would have written.
        const key = `${item.feedId}\u0000${item.dedupeKey}`;
        const ledger = options.dryRunLedger ?? (options.dryRunLedger = new Map());
        const prior = ledger.get(key);
        if (!prior) {
          counts.created += 1;
          counts.labelAssignments += item.labels.length;
          ledger.set(key, { isRead: item.isRead, isStarred: item.isStarred, hasEnclosures: item.enclosures.length > 0, labels: new Set(item.labels) });
          continue;
        }
        const addedLabels = item.labels.filter((name) => !prior.labels.has(name));
        const changed = (item.isRead && !prior.isRead) || (item.isStarred && !prior.isStarred) || (!prior.hasEnclosures && item.enclosures.length > 0) || addedLabels.length > 0;
        if (changed) { counts.updated += 1; counts.labelAssignments += addedLabels.length; } else counts.unchanged += 1;
        prior.isRead ||= item.isRead;
        prior.isStarred ||= item.isStarred;
        prior.hasEnclosures ||= item.enclosures.length > 0;
        addedLabels.forEach((name) => prior.labels.add(name));
        continue;
      }
      if (!existing) {
        counts.created += 1;
        counts.labelAssignments += item.labels.length;
        const link = item.link || `${item.feedUrl}#${encodeURIComponent(item.dedupeKey)}`;
        const content = sanitizer.sanitize(item.content);
        const imageUrl = item.enclosures.find((e) => e.type === "image" || e.type.startsWith("image/"))?.href ?? null;
        const meta = computeArticleMeta({ content, contentFormat: "html", title: item.title, link, imageUrl, enclosures: item.enclosures, feedUrl: item.feedUrl });
        creates.push({
          item,
          row: {
            userId,
            feedId: item.feedId,
            title: item.title,
            link,
            externalId: item.guid || item.link || null,
            dedupeKey: item.dedupeKey,
            contentHash: computeContentHash(link),
            content,
            excerpt: sanitizer.sanitize(content, { ALLOWED_TAGS: [] }).substring(0, 200),
            author: item.author,
            publishedAt: item.publishedAt,
            // Read/starred items keep FreshRSS' crawl time. Unread ones are stamped "now" (column
            // default) so incremental sync clients (GReader/Fever) that only look at recently
            // created articles still receive them.
            ...(item.discoveredAt && (item.isRead || item.isStarred) ? { createdAt: item.discoveredAt } : {}),
            imageUrl,
            enclosures: item.enclosures.length ? JSON.stringify(item.enclosures) : null,
            isRead: item.isRead,
            readAt: item.isRead ? new Date() : null,
            isStarred: item.isStarred,
            ...meta,
          },
        });
        continue;
      }

      // Merge into the existing article: states only ever turn on, labels only get added.
      const pending = updatesById.get(existing.id);
      const data: Record<string, unknown> = {};
      const alreadyRead = existing.isRead || pending?.data.isRead === true;
      const alreadyStarred = existing.isStarred || pending?.data.isStarred === true;
      if (item.isRead && !alreadyRead) { data.isRead = true; data.readAt = new Date(); }
      if (item.isStarred && !alreadyStarred) data.isStarred = true;
      if (!existing.enclosures && !pending?.data.enclosures && item.enclosures.length) data.enclosures = JSON.stringify(item.enclosures);
      const have = new Set(existing.labels.map((l) => l.labelId));
      const missingLabelNames = item.labels.filter((name) => {
        const id = labelId(name);
        return !pending?.names.has(name) && (id === undefined || !have.has(id));
      });
      if (Object.keys(data).length || missingLabelNames.length) {
        if (!pending) counts.updated += 1;
        counts.labelAssignments += missingLabelNames.length;
        const target = pending ?? { id: existing.id, data: {}, labelIds: new Set<string>(), names: new Set<string>() };
        Object.assign(target.data, data);
        for (const name of missingLabelNames) {
          target.names.add(name);
          const id = labelId(name);
          if (id) target.labelIds.add(id);
        }
        updatesById.set(existing.id, target);
      } else if (!pending) {
        counts.unchanged += 1;
      }
    }

    const updates = [...updatesById.values()];
    if (dryRun || (!creates.length && !updates.length)) return;

    const extIds = await allocateExternalIds(db as unknown as PrismaClient, creates.length);
    creates.forEach((create, i) => { create.row.extId = extIds[i]; });

    await db.$transaction(
      async (tx) => {
        if (creates.length) {
          const created = await tx.article.createManyAndReturn({
            data: creates.map((c) => c.row) as never,
            select: { id: true, feedId: true, dedupeKey: true },
          });
          const idByKey = new Map(created.map((row) => [`${row.feedId}\u0000${row.dedupeKey}`, row.id]));
          const links: { articleId: string; labelId: string; userId: string }[] = [];
          for (const { item } of creates) {
            const articleId = idByKey.get(`${item.feedId}\u0000${item.dedupeKey}`);
            if (!articleId) continue;
            for (const name of item.labels) {
              const id = labelId(name);
              if (id) links.push({ articleId, labelId: id, userId });
            }
          }
          if (links.length) await tx.articleLabel.createMany({ data: links });
        }
        for (const update of updates) {
          if (Object.keys(update.data).length) await tx.article.updateMany({ where: { id: update.id, userId }, data: update.data });
          if (update.labelIds.size) {
            await tx.articleLabel.createMany({ data: [...update.labelIds].map((id) => ({ articleId: update.id, labelId: id, userId })) });
          }
        }
      },
      { timeout: 60_000, maxWait: 30_000 },
    );
  };

  let done = 0;
  for (let offset = 0; offset < rawItems.length; offset += chunkSize) {
    const chunk = rawItems.slice(offset, offset + chunkSize);
    const { created, updated, unchanged, labelAssignments, starred, read } = counts;
    try {
      await processChunk(chunk);
    } catch (error) {
      // The chunk's transaction rolled back: undo its counters and report it. Re-running
      // the import is safe (idempotent) and resumes from the chunks that did commit.
      Object.assign(counts, { created, updated, unchanged, labelAssignments, starred, read });
      counts.skipped += chunk.length;
      addError(`${options.fileName ?? "articles"} (items ${offset + 1}–${offset + chunk.length}): ${error instanceof Error ? error.message : String(error)}`);
    }
    done += chunk.length;
    await new Promise<void>((resolve) => setImmediate(resolve));
    options.onProgress?.({ phase: "articles", file: options.fileName, done, total: rawItems.length });
  }
  return report;
}
