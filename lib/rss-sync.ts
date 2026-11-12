import { createHash } from "node:crypto";
import { assessExtraction } from "./extraction-quality";
import { applyFeedContentRules } from "./feed-content-rules-client";
import { writeSystemLog } from "./system-log";
import { db } from "./db";
import { applyAutoReadRules } from "./auto-read-rules";
import { applyKeywordAlerts } from "./keyword-alerts";
import { queueNewArticleNotifications } from "./notifications";
import { applyFeedReadFilter } from "./feed-content-filter";
import { API_SOURCE_ATTENTION_STATUS, apiSourceAttentionCode, isApiSourceDeferredError } from "./api-source-errors";
import { fetchFeedArticles, type FetchedFeedArticle } from "./feed-fetcher";
import { syncDynamicOpmlCategories } from "./dynamic-opml";
import { computeContentHash, normalizeLinkForComparison } from "./content-hash";
import { buildDedupeKey, isFreshRssHashedCriteria, legacyDedupeKeys } from "./dedupe-key";
import { decryptIfValue } from "./crypto";
import type { AiConfig, MeteredAiConfig } from "./ai-summary";
import { logger, urlForLog } from "./logger";
import { getConnectorSecretRules, redactConnectorTextWith, stripConnectorSecretsWith } from "./connector-secrets";
import { sanitizeFeedItemBodies } from "./feed-item-sanitize-client";
import { isHtmlWorkerError } from "./html-worker";
import { runAsBackgroundHtmlWork } from "./html-worker/pool";
import { resolveFullTextMode } from "./full-text-mode";
import { filterByFullTextConditions } from "./full-text-conditions";
import { EscalationBudgetExhaustedError, fetchAndExtractReadable, type EscalationBudget } from "./readability-extract";
import { RecentFullTextIndex, RECENT_FULL_TEXT_LIMIT, baselinesDiffer } from "./full-text-duplicates";
import { decideFullText, leadCoverage } from "./extraction-quality";
import { adaptiveInterval, publicationCadence, dueFeedWhere, initialSyncAt, deferredSyncAt } from "./adaptive-refresh";
import { drainHostQueues } from "./host-sync-queue";
import { hostSpacingMs, hostSpacingRemainingMs, HostDeferredError, withPoliteHost, recordHostFailure, classifyFetchFailure, hostBackoffRemainingMs } from "./host-backoff";
import {
    FULL_TEXT_STATE_SELECT,
    MAX_FULL_TEXT_FETCHES_PER_SYNC,
    feedBaseline,
    needsFullTextAttempt,
    recordFullTextMiss,
    storeFullText,
    type FullTextArticleState,
} from "./full-text-store";
import { applySyncFailure, applySyncSuccess } from "./feed-auto-mute";
import { computeArticleMeta, estimateReadMinutes, htmlToPlainText, markdownToPlainText } from "./article-kind";
import { computeHeuristicEnrichment } from "./enrichment-heuristics";
import { persistEnrichment } from "./article-enrichment";
import { AiBudgetError } from "./ai/errors";
import { warnBudgetOnce } from "./ai/usage";
import { isGoogleNewsFeedUrl } from "./google-news";
import { UNTITLED } from "./title-synthesis";
import { googleNewsStableKey, prepareGoogleNewsArticles, type GoogleNewsPreparedArticle } from "./google-news-ingest";
import { GOOGLE_NEWS_MIN_UPDATE_MINUTES } from "./google-news-url";
import type { ResolveOptions } from "./google-news";
import { NEWSLETTER_SOURCE_TYPE } from "./newsletter-constants";

const MAX_AUTO_SUMMARIES_PER_SYNC = 3;
const MAX_AUTO_TAG_PER_SYNC = 3;
const MAX_AI_EXTRACTIONS_PER_SYNC_BATCH = 5;
// Per-sync caps for the other escalation tiers of unattended full text.
export const MAX_RENDER_ESCALATIONS_PER_SYNC = 10;
export const MAX_HOSTED_ESCALATIONS_PER_SYNC = 5;

export interface ArticleSyncInput {
    feedId: string;
    userId: string;
    title: string;
    link: string;
    externalId: string | null;
    dedupeKey: string;
    /**
     * Keys this article may still be stored under from an older identity algorithm
     * (`legacyDedupeKeys`). A row found only under one of them is re-keyed in place.
     */
    legacyDedupeKeys?: string[];
    upstreamContentHash?: string | null;
    contentHash: string | null;
    content: string;
    excerpt: string;
    author: string | null;
    publishedAt: Date;
    imageUrl?: string | null;
    enclosures?: string | null;
    /** Optional enrichment missing this run: an existing row is left untouched (monotonic content). */
    keepStored?: boolean;
    // List metadata (lib/article-kind.ts#computeArticleMeta). Optional so callers
    // that do not provide it leave the nullable columns for the backfill.
    kind?: string | null;
    readMinutes?: number | null;
    mediaUrl?: string | null;
    mediaType?: string | null;
    mediaDurationSecs?: number | null;
    // K3 heuristic enrichment (lib/enrichment-heuristics.ts): only ever `true`,
    // written on INSERT only — the AI pass and re-syncs never fight over them.
    isSponsored?: boolean | null;
    isClickbait?: boolean | null;
    enrichSource?: string | null;
    // Not persisted: the item had no link and `link` is the synthetic
    // `<feed url>#<dedupe key>` fallback. A rewrite of only that synthetic link
    // (feed URL changed, connector secret stripped) is not a content change and
    // must not bump Article.updatedAt (GReader ot/nt sync depends on it).
    linkSynthetic?: boolean;
    // Not persisted: a link-only rewrite of an existing row because a Google
    // News redirect link was resolved to the publisher URL on a later sync
    // (lib/google-news-ingest.ts). Same rule: keep Article.updatedAt.
    linkCosmetic?: boolean;
    // Not persisted: the feed supplied no title and `title` was synthesized
    // from content (lib/title-synthesis.ts). An existing row keeps its stored
    // title, except that the legacy "Untitled" placeholder is upgraded
    // cosmetically — never touching Article.updatedAt (GReader ot/nt).
    titleSynthetic?: boolean;
    // Not persisted: the placeholder the pre-synthesis code stored for this
    // item (`raw || "Untitled"`), used to recognise upgradable legacy rows.
    identityTitle?: string;
    // Not persisted: the item had no date and `publishedAt` is the sync time.
    // An existing row keeps its stored date (otherwise every re-sync of a
    // date-less feed would rewrite the row and bump Article.updatedAt).
    publishedAtSynthetic?: boolean;
}

export interface ArticleSyncResult {
    upsertedIds: string[];
    createdArticleIds: string[];
    /**
     * Rows that should get a full-text extraction attempt if the feed has a
     * full-text mode: new rows first, then existing rows whose upstream content
     * genuinely changed or whose previous attempt is retryable (never attempted,
     * deferred by host backoff, or failed fewer than MAX_FULL_TEXT_ATTEMPTS
     * times). Rows with stored full text and an unchanged feed item are NOT in
     * here — re-syncing an unchanged feed causes zero page fetches.
     */
    fullTextCandidateIds: string[];
}

export interface UpsertArticleBatchOptions {
    /**
     * The feed has an active full-text mode. Enables the one-time recognition of
     * legacy rows (from before Article.feedContent existed) whose `content` is
     * previously extracted full text rather than the feed item.
     */
    fullTextActive?: boolean;
}

// The fields the original per-article `upsert.update` clause overwrote on an existing
// row. Kept as a single list so the "did anything actually change" comparison and the
// update payload can't drift apart.
function updatableFields(article: ArticleSyncInput) {
    return {
        upstreamContentHash: article.upstreamContentHash,
        title: article.title,
        link: article.link,
        externalId: article.externalId,
        content: article.content,
        excerpt: article.excerpt,
        author: article.author,
        publishedAt: article.publishedAt,
        imageUrl: article.imageUrl ?? null,
        enclosures: article.enclosures ?? null,
        ...metaFields(article),
    };
}

// Derived from the fields above, so it is written whenever they are (and an
// unchanged row keeps whatever it has; nulls are filled by the backfill).
function metaFields(article: ArticleSyncInput) {
    if (article.kind === undefined) return {};
    return {
        kind: article.kind ?? null,
        readMinutes: article.readMinutes ?? null,
        mediaUrl: article.mediaUrl ?? null,
        mediaType: article.mediaType ?? null,
        mediaDurationSecs: article.mediaDurationSecs ?? null,
    };
}

// Heuristic flags for brand-new rows. Deliberately NOT part of updatableFields.
function enrichFields(article: ArticleSyncInput) {
    if (!article.isSponsored && !article.isClickbait) return {};
    return {
        ...(article.isSponsored ? { isSponsored: true } : {}),
        ...(article.isClickbait ? { isClickbait: true } : {}),
        enrichSource: article.enrichSource ?? "heuristic",
    };
}

const EXISTING_ROW_SELECT = {
    upstreamContentHash: true,
    id: true,
    dedupeKey: true,
    title: true,
    link: true,
    externalId: true,
    content: true,
    excerpt: true,
    author: true,
    publishedAt: true,
    imageUrl: true,
    enclosures: true,
    updatedAt: true,
    feedContent: true,
    fullTextStatus: true,
    fullTextAttempts: true,
    fullTextFetchedAt: true,
} as const;

type ExistingArticleRow = { id: string; dedupeKey: string | null; updatedAt: Date };

/**
 * Identity upgrade (FreshRSS `sha1:*` unicity): an article not found under its
 * current key but stored under one of its `legacyDedupeKeys` is the same article.
 * Its row is re-keyed in place, keeping id, read/star state and labels, and
 * `updatedAt` (re-keying is not a content change; GReader ot/nt clocks rely on it).
 * The update is conditional on the old key and `updatedAt`, so a concurrent sync
 * that already moved or changed the row wins and nothing is duplicated by us.
 * Returns the re-keyed rows (with their new key) for the regular change check.
 */
async function rekeyLegacyRows<Row extends ExistingArticleRow>(
    userId: string,
    feedId: string,
    articles: ArticleSyncInput[],
    found: Row[],
): Promise<Row[]> {
    const foundKeys = new Set(found.map((row) => row.dedupeKey));
    const pending = articles.filter((article) => article.legacyDedupeKeys?.length && !foundKeys.has(article.dedupeKey));
    if (!pending.length) return [];

    const legacyKeys = [...new Set(pending.flatMap((article) => article.legacyDedupeKeys!))];
    const legacyRows = (await db.article.findMany({
        where: { userId, feedId, dedupeKey: { in: legacyKeys } },
        select: EXISTING_ROW_SELECT,
    })) as unknown as Row[];
    if (!legacyRows.length) return [];

    const byKey = new Map(legacyRows.map((row) => [row.dedupeKey as string, row]));
    const claimed = new Set<string>();
    const rekeyed: Row[] = [];
    for (const article of pending) {
        const row = article.legacyDedupeKeys!.map((key) => byKey.get(key)).find((candidate) => candidate && !claimed.has(candidate.id));
        if (!row) continue;
        claimed.add(row.id);
        try {
            const result = await db.article.updateMany({
                where: { id: row.id, userId, dedupeKey: row.dedupeKey, updatedAt: row.updatedAt },
                data: { dedupeKey: article.dedupeKey, updatedAt: row.updatedAt },
            });
            if (result.count === 1) rekeyed.push({ ...row, dedupeKey: article.dedupeKey });
        } catch (error) {
            // Unique (userId, feedId, dedupeKey) race: another sync stored the new key first.
            logger.warn("[rss-sync] re-keying a legacy article row failed:", error);
        }
    }
    return rekeyed;
}

/**
 * Folds articles that share a dedupe key within the same batch down to one entry,
 * mirroring what a sequential `upsert` loop over the same array would leave in the
 * DB: the first occurrence's identity (id-defining fields: dedupeKey/contentHash) is
 * kept, but the overwritable fields end up with the *last* occurrence's values,
 * since each subsequent upsert in the original loop would overwrite them again.
 * This also sidesteps a `createMany` unique-constraint violation when a feed's
 * `unicityCriteria` is loose enough to produce duplicate keys within one fetch.
 */
function foldByDedupeKey(articles: ArticleSyncInput[]): ArticleSyncInput[] {
    const order: string[] = [];
    const byKey = new Map<string, ArticleSyncInput>();
    for (const article of articles) {
        const prior = byKey.get(article.dedupeKey);
        if (!prior) {
            order.push(article.dedupeKey);
            byKey.set(article.dedupeKey, article);
        } else {
            byKey.set(article.dedupeKey, { ...prior, ...updatableFields(article) });
        }
    }
    return order.map((key) => byKey.get(key)!);
}

// better-sqlite3 resolves every query synchronously, so a chain of awaited DB calls only ever
// yields microtasks: a sync tick that parses/inserts feed after feed would hold the event loop
// (and with it every HTTP request) until the next real network wait. These macrotask yields give
// pending requests a turn between feeds and inside the per-row DB loops (audit R5).
const yieldToLoop = () => new Promise<void>((resolve) => setImmediate(resolve));

/** Concurrent feed syncs in flight (network-bound); capped so a big library can't flood the loop. */
function getSyncConcurrency() {
    const n = Number(process.env.FEEDFERRET_SYNC_CONCURRENCY);
    return Number.isFinite(n) && n >= 1 ? Math.min(Math.trunc(n), 8) : 4;
}

/**
 * Runs `fn` over `items` with at most `limit` in flight (a worker pool, so one slow feed no
 * longer stalls the other three like the old fixed batches did), yielding to the event loop
 * before each task. Results keep the input order.
 */
async function mapWithConcurrency<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
    const results = new Array<R>(items.length);
    let next = 0;
    const worker = async () => {
        while (next < items.length) {
            const index = next++;
            await yieldToLoop();
            results[index] = await fn(items[index]);
        }
    };
    await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
    return results;
}

/**
 * Batches what used to be a per-article `findUnique` -> `upsert` -> cross-feed
 * `findFirst` -> conditional `update` loop (P-1) into a small, fixed number of
 * queries regardless of batch size:
 *  1. one `findMany` to load existing rows for the batch's dedupe keys
 *  2. one `createManyAndReturn` for genuinely-new articles
 *  3. individual `update`s only for existing rows whose fetched fields actually
 *     differ from what's stored (an unconditional overwrite would otherwise just
 *     rewrite identical data)
 *  4. one `findMany` over the batch's content hashes for cross-feed duplicate
 *     detection, resolved in memory, instead of one `findFirst` per new article
 *
 * Dedupe semantics are unchanged: the same `userId_feedId_dedupeKey` identifies an
 * "existing" row, and cross-feed duplicate linking still picks the earliest-created
 * non-duplicate article sharing a `contentHash` as canonical — including another
 * article created earlier in this same batch, which the original sequential loop
 * would also have seen (each iteration's insert was committed, and thus visible,
 * before the next iteration's duplicate check ran).
 */
export async function upsertArticleBatch(
    rawArticles: ArticleSyncInput[],
    options: UpsertArticleBatchOptions = {},
): Promise<ArticleSyncResult> {
    if (rawArticles.length === 0) return { upsertedIds: [], createdArticleIds: [], fullTextCandidateIds: [] };

    await yieldToLoop();
    const articles = foldByDedupeKey(rawArticles);
    const { userId, feedId } = articles[0];
    const dedupeKeys = articles.map((a) => a.dedupeKey);

    const existingRows = await db.article.findMany({
        where: { userId, feedId, dedupeKey: { in: dedupeKeys } },
        select: EXISTING_ROW_SELECT,
    });
    existingRows.push(...(await rekeyLegacyRows(userId, feedId, articles, existingRows)));
    const existingByDedupeKey = new Map(
        existingRows
            .filter((row) => row.dedupeKey !== null)
            .map((row) => [row.dedupeKey as string, row] as const),
    );

    const upsertedIds: string[] = [];
    const retryFullText: { id: string; lastTry: number }[] = [];
    const newArticles: ArticleSyncInput[] = [];

    for (let article of articles) {
        const existing = existingByDedupeKey.get(article.dedupeKey);
        if (!existing) {
            newArticles.push(article);
            continue;
        }

        upsertedIds.push(existing.id);

        // A synthesized title is display-only provenance, never a content
        // change: keep the stored title for the change check. A legacy
        // placeholder row ("Untitled") is upgraded below as a cosmetic write.
        let cosmeticTitle: string | null = null;
        if (article.titleSynthetic) {
            if (existing.title !== article.title && existing.title === (article.identityTitle ?? UNTITLED)) {
                cosmeticTitle = article.title;
            }
            article = { ...article, title: existing.title };
        }
        if (article.publishedAtSynthetic) {
            article = { ...article, publishedAt: existing.publishedAt };
        }

        // A changed cleaning configuration is never an upstream edit. Adopt hashes
        // conservatively for legacy rows; apply rules on their next publisher edit.
        const legacyFullTextCandidate = options.fullTextActive && existing.feedContent == null &&
            existing.fullTextStatus === null && existing.content !== article.content &&
            htmlToPlainText(existing.content).length > htmlToPlainText(article.content).length * 1.2 + 100;
        if (article.upstreamContentHash && !legacyFullTextCandidate &&
            (!existing.upstreamContentHash || existing.upstreamContentHash === article.upstreamContentHash)) {
            article = { ...article, content: existing.feedContent ?? existing.content, excerpt: existing.excerpt ?? "", keepStored: true };
        }
        const next = updatableFields(article);
        const linkChanged = existing.link !== next.link;
        // Optional enrichment missing this run: the content-derived fields of the
        // stored row are frozen (neither compared nor written). Everything else
        // (link/title rewrites, full-text retries) proceeds as usual.
        const keep = article.keepStored === true;

        // Full text (lib/full-text-store.ts): when `content` holds extracted full
        // text, the feed item lives in `feedContent` and upstream changes are
        // detected against THAT — the stored full text must neither look like a
        // change nor be overwritten by the feed teaser.
        let hasFullText = existing.feedContent != null;
        let legacyFullText = false;
        if (
            !hasFullText &&
            !keep &&
            options.fullTextActive &&
            existing.fullTextStatus === null &&
            existing.content !== next.content &&
            htmlToPlainText(existing.content).length > htmlToPlainText(next.content).length * 1.2 + 100
        ) {
            // Row from before feedContent existed whose content was replaced by
            // extracted full text: adopt it as stored full text (one-time, no fetch).
            hasFullText = true;
            legacyFullText = true;
        }
        const baseline = hasFullText && !legacyFullText ? existing.feedContent! : existing.content;
        const contentChanged = !legacyFullText && !keep && baseline !== next.content;

        const otherChanged =
            existing.externalId !== next.externalId ||
            contentChanged ||
            // With stored full text the excerpt is derived from it, not the feed.
            (!hasFullText && !keep && existing.excerpt !== next.excerpt) ||
            existing.author !== next.author ||
            existing.publishedAt.getTime() !== next.publishedAt.getTime() ||
            (!keep && (existing.imageUrl ?? null) !== next.imageUrl) ||
            (!keep && (existing.enclosures ?? null) !== next.enclosures) ||
            existing.title !== next.title;

        // Fields an update writes: with stored full text the feed's content goes
        // to feedContent and content/excerpt/readMinutes stay the full text's.
        const writable: Record<string, unknown> = { ...next };
        if (keep) {
            for (const key of ["content", "excerpt", "imageUrl", "enclosures", "kind", "readMinutes", "mediaUrl", "mediaType", "mediaDurationSecs"]) delete writable[key];
        }
        if (hasFullText) {
            delete writable.content;
            delete writable.excerpt;
            delete writable.readMinutes;
            if (contentChanged || legacyFullText) writable.feedContent = next.content;
        }
        // A genuine upstream change of the content OR of the source link (a
        // different page) invalidates the previous full-text attempt, so it is
        // extracted again exactly once for the new version. Cosmetic link
        // rewrites (synthetic links, resolved Google News redirects) do not.
        // Same page behind a different spelling (scheme, host case, fragment,
        // trailing slash, rotating tracking/session params) is cosmetic too:
        // store the new link, but no reset/refetch and no updatedAt bump.
        const cosmeticLink =
            article.linkSynthetic ||
            article.linkCosmetic ||
            (linkChanged && normalizeLinkForComparison(existing.link) === normalizeLinkForComparison(next.link));
        const sourceChanged = contentChanged || (linkChanged && !cosmeticLink);
        const fullTextReset = sourceChanged ? { fullTextStatus: null, fullTextReason: null, fullTextAttempts: null } : {};
        const legacyAdopt = legacyFullText ? { feedContent: next.content, fullTextStatus: "ok", fullTextReason: "legacy" } : {};

        if (otherChanged || (linkChanged && !cosmeticLink)) {
            await db.article.update({
                where: { id: existing.id },
                data: { ...writable, ...fullTextReset, ...legacyAdopt, ...(cosmeticTitle ? { title: cosmeticTitle } : {}) },
            });
            if (upsertedIds.length % 25 === 0) await yieldToLoop();
        } else if (linkChanged || cosmeticTitle || legacyFullText || (article.upstreamContentHash && article.upstreamContentHash !== existing.upstreamContentHash)) {
            // Synthetic / resolved-redirect link rewrite, legacy placeholder
            // title upgrade and/or adopting legacy full text only: store it,
            // keep updatedAt.
            await db.article.update({
                where: { id: existing.id },
                data: {
                    ...(article.upstreamContentHash && article.upstreamContentHash !== existing.upstreamContentHash ? { upstreamContentHash: article.upstreamContentHash } : {}),
                    ...(linkChanged ? { link: next.link } : {}),
                    ...(linkChanged && article.linkCosmetic && article.contentHash ? { contentHash: article.contentHash } : {}),
                    ...(cosmeticTitle ? { title: cosmeticTitle } : {}),
                    ...legacyAdopt,
                    updatedAt: existing.updatedAt,
                },
            });
        }

        if (
            sourceChanged ||
            (!legacyFullText && needsFullTextAttempt({ fullTextStatus: existing.fullTextStatus, fullTextAttempts: existing.fullTextAttempts }))
        ) {
            // Upstream changes first (never tried for this version), then the
            // least recently tried retries, so no row starves behind others.
            retryFullText.push({ id: existing.id, lastTry: sourceChanged ? -1 : existing.fullTextFetchedAt?.getTime() ?? -1 });
        }
    }

    const createdArticleIds: string[] = [];

    if (newArticles.length > 0) {
        // Cross-feed duplicate candidates that existed *before* this batch, queried
        // up front (before any inserts) so real historical creation order can't get
        // entangled with same-batch rows that may share an identical DB timestamp.
        const contentHashes = Array.from(
            new Set(newArticles.map((a) => a.contentHash).filter((hash): hash is string => !!hash)),
        );
        const preExistingCandidates = contentHashes.length > 0
            ? await db.article.findMany({
                where: { userId, contentHash: { in: contentHashes }, isDuplicate: false },
                orderBy: { createdAt: "asc" },
                select: { id: true, contentHash: true },
            })
            : [];

        let created: { id: string; dedupeKey: string | null; contentHash: string | null }[];
        try {
            created = await db.article.createManyAndReturn({
                data: newArticles.map((article) => ({
                    feedId: article.feedId,
                    userId: article.userId,
                    title: article.title,
                    link: article.link,
                    externalId: article.externalId,
                    dedupeKey: article.dedupeKey,
                    contentHash: article.contentHash,
                    upstreamContentHash: article.upstreamContentHash,
                    content: article.content,
                    excerpt: article.excerpt,
                    author: article.author,
                    publishedAt: article.publishedAt,
                    imageUrl: article.imageUrl ?? null,
                    enclosures: article.enclosures ?? null,
                    ...metaFields(article),
                    ...enrichFields(article),
                })),
                select: { id: true, dedupeKey: true, contentHash: true },
            });
        } catch (error) {
            // A concurrent sync of the same feed could race us on the unique
            // (userId, feedId, dedupeKey) constraint that `createMany` doesn't
            // resolve the way `upsert` does. Fall back to per-row upserts for just
            // this batch of new articles rather than failing the whole sync.
            logger.warn("[rss-sync] batched article insert conflicted, falling back to per-row upsert:", error);
            created = [];
            for (const article of newArticles) {
                const row = await db.article.upsert({
                    where: {
                        userId_feedId_dedupeKey: {
                            userId: article.userId,
                            feedId: article.feedId,
                            dedupeKey: article.dedupeKey,
                        },
                    },
                    update: updatableFields(article),
                    create: {
                        feedId: article.feedId,
                        userId: article.userId,
                        title: article.title,
                        link: article.link,
                        externalId: article.externalId,
                        dedupeKey: article.dedupeKey,
                        contentHash: article.contentHash,
                        upstreamContentHash: article.upstreamContentHash,
                        content: article.content,
                        excerpt: article.excerpt,
                        author: article.author,
                        publishedAt: article.publishedAt,
                        imageUrl: article.imageUrl ?? null,
                        enclosures: article.enclosures ?? null,
                        ...metaFields(article),
                        ...enrichFields(article),
                    },
                    select: { id: true, dedupeKey: true, contentHash: true },
                });
                created.push(row);
            }
        }

        for (const row of created) {
            upsertedIds.push(row.id);
            createdArticleIds.push(row.id);
        }

        // Resolve which article is canonical per content hash: a pre-existing
        // article always wins (it was necessarily created before "now"); failing
        // that, the first new article for that hash *in original fetch order*
        // becomes canonical, matching what the sequential loop would have left as
        // non-duplicate (the first one processed finds no candidate yet).
        const canonicalByHash = new Map<string, string>();
        for (const row of preExistingCandidates) {
            if (row.contentHash && !canonicalByHash.has(row.contentHash)) {
                canonicalByHash.set(row.contentHash, row.id);
            }
        }

        const createdIdByDedupeKey = new Map(
            created.filter((row) => row.dedupeKey !== null).map((row) => [row.dedupeKey as string, row.id]),
        );
        for (const article of newArticles) {
            if (!article.contentHash) continue;
            const createdId = createdIdByDedupeKey.get(article.dedupeKey);
            if (!createdId) continue;
            if (!canonicalByHash.has(article.contentHash)) {
                canonicalByHash.set(article.contentHash, createdId);
            }
        }

        for (const article of newArticles) {
            if (!article.contentHash) continue;
            const createdId = createdIdByDedupeKey.get(article.dedupeKey);
            if (!createdId) continue;
            const canonicalId = canonicalByHash.get(article.contentHash);
            if (canonicalId && canonicalId !== createdId) {
                await db.article.update({
                    where: { id: createdId },
                    data: { isDuplicate: true, duplicateOf: canonicalId },
                });
                await yieldToLoop();
            }
        }
    }

    const retryFullTextIds = retryFullText.sort((a, b) => a.lastTry - b.lastTry).map((r) => r.id);
    return { upsertedIds, createdArticleIds, fullTextCandidateIds: [...createdArticleIds, ...retryFullTextIds] };
}

export interface SyncFeedOptions {
    /**
     * The caller runs a full `applyAutoReadRules` pass after syncing (see
     * syncUserFeeds), so the extra per-feed pass over freshly AI-enriched
     * articles would only evaluate (and fire) the same rules twice.
     */
    deferAutoReadRules?: boolean;
    background?: boolean;
    /** The bulk host queue retries busy feeds in this run, without persisting intermediate waits. */
    retryBusyHostInRun?: boolean;
    /** Google News link resolution limits (tests / interactive add). */
    googleNews?: ResolveOptions;
}

/**
 * Syncs a single feed for a specific user.
 */
export async function syncFeed(userId: string, feedId: string, options: SyncFeedOptions = {}) {
    const feed = await db.feed.findUnique({
        where: { id: feedId, userId },
        include: { user: { select: { autoMuteFailingFeedsAfter: true, defaultUpdateFrequency: true } }, category: { include: { parent: true } } },
    });

    if (!feed) throw new Error("Feed not found");
    // N1: newsletter feeds are filled by inbound mail (lib/inbound-email.ts) and
    // have no fetchable URL — a sync must not fail/auto-mute them.
    if (feed.sourceType === NEWSLETTER_SOURCE_TYPE) return { success: true, count: 0, createdArticleIds: [] };

    const scheduleFrom = async (consecutiveFailureCount: number) => {
        const items = await db.article.findMany({
            where: { feedId: feed.id, publishedAt: { lte: new Date() } },
            orderBy: { publishedAt: "desc" }, take: 40,
            select: { publishedAt: true, createdAt: true },
        });
        const minutes = politeUpdateFrequency({ ...feed, consecutiveFailureCount }, adaptiveInterval(items, feed.updateFrequency, computeEffectiveUpdateFrequency(feed, feed.user.defaultUpdateFrequency)));
        return { minutes, cadenceMinutes: publicationCadence(items) };
    };

    // Unscheduled rows that were fetched before (legacy rows, edited/restored/unmuted feeds): a recent fetch
    // keeps its interval, so adoption never refetches a fresh feed early; the jitter only spreads overdue
    // ones. Never-fetched feeds (OPML/FreshRSS/GReader imports, API/MCP creates) are due immediately, so
    // the first reader boot after an import fetches them; their outcome persists a schedule below.
    if (options.background && feed.nextSyncAt === null && feed.lastFetchedAt) {
        const jittered = initialSyncAt(feed.id);
        const fromLastFetch = new Date(feed.lastFetchedAt.getTime() + (await scheduleFrom(feed.consecutiveFailureCount)).minutes * 60_000);
        await db.feed.updateMany({ where: { id: feed.id, nextSyncAt: null }, data: { nextSyncAt: fromLastFetch > jittered ? fromLastFetch : jittered } });
        return { success: true, skipped: true, deferred: true, deferredReason: "initial_schedule", count: 0, createdArticleIds: [] };
    }

    // Connector secrets (RSSHub key / changedetection.io token) must not reach
    // stored article links, feed errors, notifications or rule payloads.
    const secretRules = await getConnectorSecretRules();
    const publicFeedUrl = stripConnectorSecretsWith(secretRules, feed.url);
    const redact = (text: string) => redactConnectorTextWith(secretRules, text);

    try {
        const remoteFeed = options.background
            ? await withPoliteHost(feed.url, () => fetchFeedArticles(feed))
            : await fetchFeedArticles(feed);
        const scheduleNext = async () => {
            const { minutes, cadenceMinutes } = await scheduleFrom(0);
            return { nextSyncAt: new Date(Date.now() + minutes * 60_000), cadenceMinutes };
        };
        // G1: Google News keyword feeds — resolve redirect links to publisher
        // URLs (bounded, cached; falls back to the Google link).
        const isGoogleNews = isGoogleNewsFeedUrl(feed.url);
        if (!remoteFeed.notModified && isGoogleNews && remoteFeed.articles.length > 0) {
            remoteFeed.articles = await prepareGoogleNewsArticles(feed, userId, remoteFeed.articles, options.googleNews);
        }

        if (remoteFeed.notModified) {
            // Conditional GET (P-2): server confirmed nothing changed since our last
            // fetch, so skip article processing entirely. A 304 response is allowed
            // to omit ETag/Last-Modified (RFC 7232) — only overwrite our stored
            // values if the server actually repeated them; otherwise keep what we
            // have so the next request can still send a conditional GET.
            await db.feed.update({
                where: { id: feed.id },
                data: {
                    ...await scheduleNext(),
                    lastFetchedAt: new Date(),
                    lastStatus: "ok",
                    lastError: null,
                    ...applySyncSuccess(),
                    failingSince: null,
                    lastSuccessAt: new Date(),
                    ...(remoteFeed.etag ? { etag: remoteFeed.etag } : {}),
                    ...(remoteFeed.lastModifiedHeader ? { lastModifiedHeader: remoteFeed.lastModifiedHeader } : {}),
                },
            });
            return { success: true, count: 0, createdArticleIds: [] };
        }

        const feedPatch: any = {
            lastFetchedAt: new Date(),
            lastStatus: "ok",
            lastError: null,
            ...applySyncSuccess(),
            failingSince: null,
            lastSuccessAt: new Date(),
            etag: remoteFeed.etag ?? null,
            lastModifiedHeader: remoteFeed.lastModifiedHeader ?? null,
        };

        if (!feed.name || feed.name === "New Feed") {
            feedPatch.name = remoteFeed.title || feed.name;
        }
        if (!feed.description && remoteFeed.description) feedPatch.description = remoteFeed.description;
        if (!feed.htmlUrl && remoteFeed.htmlUrl) feedPatch.htmlUrl = remoteFeed.htmlUrl;

        const maxChars = feed.maxSizeKb ? feed.maxSizeKb * 1024 : undefined;
        const itemContents = remoteFeed.articles.map((item) => {
            const content = item.content || item.summary || "";
            return maxChars && content.length > maxChars ? content.slice(0, maxChars) : content;
        });
        // Item bodies are attacker-controlled HTML: sanitized in the HTML
        // worker pool on bounded input, never on the main thread. The feed's
        // remove-selectors (FreshRSS `cssContentFilter`) run in the same worker
        // task, on the feed's own content too — not only on downloaded full text.
        const sanitizedItems = feed.contentRules
            ? await applyFeedContentRules(remoteFeed.articles.map((item, index) => ({ title: item.title || "", html: itemContents[index] })), feed.contentRules, feed.fullTextRemoveSelectors)
            : await sanitizeFeedItemBodies(itemContents, { removeSelectors: feed.fullTextRemoveSelectors });

        const articles = remoteFeed.articles.map((item, index) => {
            const content = itemContents[index];
            const { excerpt, html: sanitizedContent } = sanitizedItems[index];

            const externalId = item.externalId || item.link || null;
            // Google News: identity was fixed in the pre-pass from the raw item
            // (guid), so resolving the link / cleaning the title never changes it.
            // Identity uses the title as the pre-synthesis code stored it
            // (`identityTitle`), so a synthesized display title never changes
            // a title-based dedupe key of an existing row.
            const identityItem = { ...item, title: item.identityTitle ?? item.title };
            const preparedKey = (item as GoogleNewsPreparedArticle).dedupeKey;
            const hashedCriteria = !preparedKey && !isGoogleNews && isFreshRssHashedCriteria(feed.unicityCriteria);
            // FreshRSS hashes the title as published ("" when absent, never "Untitled",
            // or every title-less item would collide) and the unmodified content.
            // `item.content` is still the body as published: remove-selectors and the size
            // cap only apply to the copy sanitized in the HTML worker.
            const hashedItem = hashedCriteria ? { ...item, title: item.rawTitle ?? item.title, content: item.content || item.summary || "" } : identityItem;
            const dedupeKey = preparedKey
                ?? (isGoogleNews ? googleNewsStableKey(identityItem) : buildDedupeKey(feed, hashedItem, externalId));
            // Once a feed has been re-keyed for its criterion (marker), no legacy lookups.
            const legacyKeys = hashedCriteria && feed.dedupeRekeyedFor !== feed.unicityCriteria
                ? legacyDedupeKeys(feed, hashedItem, externalId, { ...identityItem, content: (item.content || item.summary || "") })
                : [];
            // Linkless items get a synthetic link from the feed URL — without
            // connector secrets (legacy rows may still carry the RSSHub key).
            const link = item.link || `${publicFeedUrl}#${encodeURIComponent(dedupeKey)}`;

            // Fetchers already synthesized a display title (with provenance)
            // for title-less items — see resolveItemTitle().
            const title = item.title || UNTITLED;
            const meta = computeArticleMeta({
                content: sanitizedContent,
                contentFormat: "html",
                title,
                link,
                imageUrl: item.imageUrl,
                enclosures: item.enclosures,
                feedUrl: publicFeedUrl,
                mediaUrl: item.media?.url,
                mediaType: item.media?.type,
                durationSecs: item.durationSecs,
            });

            return {
                feedId: feed.id,
                userId: userId,
                title,
                ...(item.titleSynthetic ? { titleSynthetic: true, identityTitle: item.identityTitle ?? UNTITLED } : {}),
                link,
                ...(item.link ? {} : { linkSynthetic: true }),
                ...((item as GoogleNewsPreparedArticle).linkCosmetic ? { linkCosmetic: true } : {}),
                externalId,
                dedupeKey,
                ...(legacyKeys.length ? { legacyDedupeKeys: legacyKeys } : {}),
                upstreamContentHash: createHash("sha256").update(item.content || item.summary || "").digest("hex"),
                contentHash: computeContentHash(link),
                content: sanitizedContent,
                excerpt: excerpt,
                author: item.author || null,
                publishedAt: item.publishedAt || new Date(),
                ...(item.publishedAt ? {} : { publishedAtSynthetic: true }),
                imageUrl: item.imageUrl,
                enclosures: item.enclosures?.length ? JSON.stringify(item.enclosures) : null,
                ...(item.keepStored ? { keepStored: true } : {}),
                ...meta,
                ...computeHeuristicEnrichment({
                    title,
                    text: htmlToPlainText(content.slice(0, 2_000)),
                    link,
                    html: content,
                }),
            };
        });

        const acceptedArticles = articles.filter((_, index) => !("allowed" in sanitizedItems[index]) || sanitizedItems[index].allowed);
        const fullTextMode = resolveFullTextMode(feed);
        const { createdArticleIds, fullTextCandidateIds } = await upsertArticleBatch(acceptedArticles, {
            fullTextActive: fullTextMode !== "off",
        });
        // Every item of this fetch went through rekeyLegacyRows: later syncs skip the lookup.
        if (isFreshRssHashedCriteria(feed.unicityCriteria) && feed.dedupeRekeyedFor !== feed.unicityCriteria) {
            feedPatch.dedupeRekeyedFor = feed.unicityCriteria;
        }

        await db.feed.update({
            where: { id: feed.id },
            data: { ...feedPatch, ...await scheduleNext() },
        });

        // Auto full-text extraction — only for new rows, rows whose upstream
        // content genuinely changed, and retryable earlier attempts (see
        // ArticleSyncResult.fullTextCandidateIds); never for every item of the
        // payload. `fullTextMode` defaults to "off" for every pre-existing row,
        // so it can't be trusted alone — resolveFullTextMode() falls back to the
        // legacy `autoFetchFullText` boolean.
        if (fullTextCandidateIds.length > 0 && fullTextMode !== "off") {
            // FreshRSS `cssFullContentConditions`: only matching articles get full text.
            const eligible = await filterByFullTextConditions(userId, fullTextCandidateIds, feed.fullTextConditions).catch((e) => {
                logger.warn("[rss-sync] full-text conditions failed, fetching all candidates:", e);
                return fullTextCandidateIds;
            });
            const candidates = eligible.slice(0, MAX_FULL_TEXT_FETCHES_PER_SYNC);
            if (fullTextMode === "selector") {
                await autoFetchFullTextViaEngine(userId, candidates, feed, "selector");
            } else if (fullTextMode === "auto" || fullTextMode === "ai") {
                await autoFetchFullTextViaEngine(userId, candidates, feed, fullTextMode);
            }
        }

        // Per-feed keyword content filter: mark matching new articles read on
        // arrival and drop them from every downstream new-article step so a
        // muted keyword produces no summary, tags, alerts, or notifications.
        let newArticleIds = createdArticleIds;
        if (createdArticleIds.length > 0) {
            const filteredOut = await applyFeedReadFilter(userId, feed, createdArticleIds).catch((e) => {
                logger.error("[rss-sync] content filter failed:", e);
                return [] as string[];
            });
            if (filteredOut.length > 0) {
                const filteredSet = new Set(filteredOut);
                newArticleIds = createdArticleIds.filter((id) => !filteredSet.has(id));
            }
        }

        if (newArticleIds.length > 0) {
            await autoSummarizeNewArticles(userId, newArticleIds);
            await autoTagNewArticles(userId, newArticleIds, {
                applyRules: !options.deferAutoReadRules,
            });
        }

        if (newArticleIds.length > 0) {
            await applyKeywordAlerts(userId, newArticleIds).catch((e) =>
                logger.error("[rss-sync] keyword alerts failed:", e),
            );
            await queueNewArticleNotifications(userId, newArticleIds).catch((e) =>
                logger.error("[rss-sync] push notification queue failed:", e),
            );
            // Webhook: new_article events (one per created article, non-blocking)
        }

        return { success: true, count: articles.length, createdArticleIds };
    } catch (error) {
        const { status, retryAfterMs } = classifyFetchFailure(error);
        if (status === 403) {
            await db.feed.update({ where: { id: feed.id }, data: {
                nextSyncAt: deferredSyncAt(Math.max(15 * 60_000, Date.now() - (feed.lastStatus === "attention" && feed.lastError === "HTTP 403: feed_blocked" ? feed.failingSince?.getTime() ?? Date.now() : Date.now()), retryAfterMs ?? 0)),
                failingSince: feed.lastStatus === "attention" && feed.lastError === "HTTP 403: feed_blocked" ? feed.failingSince ?? new Date() : new Date(),
                lastStatus: "attention", lastError: "HTTP 403: feed_blocked",
            } });
            return { success: true, skipped: true, deferred: true, deferredReason: "feed_blocked", count: 0, createdArticleIds: [] };
        }
        if (error instanceof HostDeferredError || status === 429 || status === 503 || retryAfterMs !== null) {
            const waitMs = error instanceof HostDeferredError ? error.waitMs : recordHostFailure(feed.url, error);
            if (!(options.retryBusyHostInRun && error instanceof HostDeferredError && error.reason === "host_busy")) {
                await db.feed.update({ where: { id: feed.id }, data: { nextSyncAt: deferredSyncAt(waitMs) } });
            }
            return { success: true, skipped: true, deferred: true, retryAfterMs: waitMs, deferredReason: error instanceof HostDeferredError ? error.reason : "host_backoff", count: 0, createdArticleIds: [] };
        }
        // A saturated (`busy`, incl. a background queue-wait deadline) or missing
        // (`unavailable`) HTML worker pool says nothing about the feed: no failure
        // streak / auto-mute, no lastFetchedAt bump — the next sync retries it.
        if (isHtmlWorkerError(error) && (error.reason === "busy" || error.reason === "unavailable")) {
            logger.warn(`[rss-sync] feed ${feed.id} (${urlForLog(feed.url)}) deferred: HTML worker ${error.reason}`);
            return { success: true, skipped: true, deferred: true, count: 0, createdArticleIds: [] };
        }
        // API platform sources: missing/rejected credentials or an exhausted shared
        // quota are not this feed's fault — same treatment as a saturated worker.
        if (isApiSourceDeferredError(error)) {
            logger.warn(`[rss-sync] feed ${feed.id} (${urlForLog(feed.url)}) deferred: API source ${error.reason}${error.status ? ` (HTTP ${error.status})` : ""}`);
            // Missing/rejected credentials need an admin: make that visible on the feed
            // (neutral "attention" status + a code the UI translates) instead of leaving
            // it silently quiet. Not a failure: no streak, no auto-mute, no lastFetchedAt
            // bump; the next successful sync overwrites it with "ok".
            if (error.reason === "unconfigured" || error.reason === "auth") {
                const lastError = apiSourceAttentionCode(error.reason);
                if (feed.lastStatus !== API_SOURCE_ATTENTION_STATUS || feed.lastError !== lastError) {
                    await db.feed
                        .update({ where: { id: feed.id }, data: { lastStatus: API_SOURCE_ATTENTION_STATUS, lastError } })
                        .catch((e: unknown) => logger.warn("[rss-sync] attention status write failed:", e));
                }
            }
            return { success: true, skipped: true, deferred: true, count: 0, createdArticleIds: [] };
        }
        // Log origin only: feed URLs can carry private tokens / userinfo (N15).
        logger.error(`Error syncing feed ${feed.id} (${urlForLog(feed.url)}):`, error);
        const failureUpdate = applySyncFailure(
            { consecutiveFailureCount: feed.consecutiveFailureCount, autoMuted: feed.autoMuted },
            feed.user.autoMuteFailingFeedsAfter,
        );
        await db.feed.update({
            where: { id: feed.id },
            data: {
                lastFetchedAt: new Date(),
                nextSyncAt: new Date(Date.now() + politeUpdateFrequency({ ...feed, consecutiveFailureCount: failureUpdate.consecutiveFailureCount }, adaptiveInterval([], feed.updateFrequency, computeEffectiveUpdateFrequency(feed, feed.user.defaultUpdateFrequency))) * 60_000),
                lastStatus: "error",
                lastError: redact(String(error)).slice(0, 1000),
                consecutiveFailureCount: failureUpdate.consecutiveFailureCount,
                autoMuted: failureUpdate.autoMuted,
                // Start of the failure streak (rows from before the column: their previous attempt).
                failingSince: feed.failingSince ?? (feed.consecutiveFailureCount > 0 ? feed.lastFetchedAt : null) ?? new Date(),
            },
        });
        const errorMessage = redact(String(error)).slice(0, 500);
        // Fire matching feed_error rules (in-app/push/email/webhook actions)
        import("@/lib/auto-read-rules")
            .then(({ applyFeedErrorRules }) =>
                applyFeedErrorRules(userId, {
                    feedId: feed.id,
                    feedName: feed.name,
                    feedUrl: publicFeedUrl,
                    error: errorMessage,
                }),
            )
            .catch((e) => logger.warn("[rss-sync] feed_error rules failed:", e));
        // F6: fire a single one-time in-app notification the moment this sync
        // crosses the auto-mute threshold — not on every subsequent failed
        // sync of an already-muted feed (it's no longer actively re-fetched
        // anyway, see syncUserFeeds/syncAllFeeds skipping autoMuted feeds).
        if (failureUpdate.justMuted) {
            db.notification
                .create({
                    data: {
                        userId,
                        type: "feed_auto_muted",
                        title: feed.name,
                        body: `Auto-muted after ${failureUpdate.consecutiveFailureCount} consecutive failed syncs: ${errorMessage}`,
                        feedId: feed.id,
                    },
                })
                .catch((e: unknown) => logger.warn("[rss-sync] feed_auto_muted notification failed:", e));
        }
        return { success: false, error: redact(String(error)) };
    }
}

/** Loads the full-text state of the candidate rows, keeping the candidates' priority order. */
async function loadFullTextCandidates(userId: string, articleIds: string[]): Promise<FullTextArticleState[]> {
    const rows = await db.article.findMany({
        where: { id: { in: articleIds }, userId },
        select: FULL_TEXT_STATE_SELECT,
    });
    const byId = new Map(rows.map((row) => [row.id, row]));
    return articleIds.map((id) => byId.get(id)).filter((row): row is FullTextArticleState => !!row && needsFullTextAttempt(row));
}

/**
 * Per-host politeness gate for unattended fetches: while a host is backing off
 * (429/403/5xx/network failures, lib/host-backoff.ts) its articles are marked
 * "deferred" and retried by a later sync instead of being fetched now.
 */
async function deferIfHostBackingOff(article: FullTextArticleState): Promise<boolean> {
    if (!article.link || hostBackoffRemainingMs(article.link) === 0) return false;
    await recordFullTextMiss(article, "deferred", "host_backoff");
    return true;
}

/**
 * The page could not be parsed within the HTML worker's limits (`too_complex`:
 * a hard failure that counts towards the retry cap), the pool was saturated
 * (`busy`) or is missing (`unavailable`): those two are retried next sync. The
 * article keeps its feed content in every case.
 */
async function recordParseAborted(article: FullTextArticleState, reason: "too_complex" | "busy" | "unavailable") {
    if (reason === "too_complex") await recordFullTextMiss(article, "failed", "too_complex");
    else await recordFullTextMiss(article, "deferred", reason === "busy" ? "parser_busy" : "parser_unavailable");
}

async function recordFullTextFetchError(article: FullTextArticleState, error: unknown) {
    const { kind, status } = classifyFetchFailure(error);
    const reason = status ? `http_${status}` : kind;
    await recordFullTextMiss(article, "failed", reason).catch((e) => logger.warn("[rss-sync] recording full-text failure failed:", e));
}

/** Scope the history query to this user's feed, with a fixed upper bound. */
function duplicateGuard(userId: string, feedId: string) {
    let index: RecentFullTextIndex | null = null;
    const observed = new Map<string, string>();
    return async (article: FullTextArticleState, html: string) => {
        // No history query or tokenisation until an acceptable candidate exists.
        if (!index) {
            index = new RecentFullTextIndex();
            const recent = await db.article.findMany({
                // feedId alone lets SQLite use the (feedId, publishedAt…) index;
                // the feed already belongs to this user.
                where: { feedId, fullTextStatus: "ok" },
                orderBy: { publishedAt: "desc" },
                take: RECENT_FULL_TEXT_LIMIT,
                select: { id: true, link: true, content: true, contentFormat: true, fullTextStatus: true },
            });
            for (const row of [...recent].reverse()) if (row.fullTextStatus === "ok") {
                index.observe(row.id, row.link, row.contentFormat === "markdown" ? markdownToPlainText(row.content) : row.content);
            }
        }
        const matches = index.observe(article.id, article.link, html);
        observed.delete(article.id);
        observed.set(article.id, html);
        if (observed.size > RECENT_FULL_TEXT_LIMIT) observed.delete(observed.keys().next().value!);
        if (!matches.length) return false;
        // Shared footers may dominate a short article. A page demonstrably
        // containing this item's own feed lead is not a wrong generic page.
        if ((leadCoverage(feedBaseline(article), html) ?? 0) >= 0.3) return false;
        const siblings = await db.article.findMany({
            where: { userId, feedId, id: { in: matches } },
            select: FULL_TEXT_STATE_SELECT,
        });
        let duplicate = false;
        for (const sibling of siblings) {
            const body = sibling.fullTextStatus === "ok"
                ? sibling.contentFormat === "markdown" ? markdownToPlainText(sibling.content) : sibling.content
                : observed.get(sibling.id);
            if (!body) continue;
            if (!index.observe(sibling.id, sibling.link, body).includes(article.id) ||
                !baselinesDiffer(feedBaseline(article), feedBaseline(sibling))) continue;
            duplicate = true;
            const coverage = leadCoverage(feedBaseline(sibling), body);
            // A verified sibling may be the genuine article; never discard it
            // because another URL temporarily served its body. An unverifiable
            // sibling (short teaser) is only discarded once the same page body
            // was served for at least three different items — then the page is
            // generic, not that sibling's article.
            const generic = coverage === null && matches.length >= 2;
            if (sibling.fullTextStatus === "ok" && (generic || (coverage !== null && coverage < 0.3))) await recordFullTextMiss(sibling, "rejected", "duplicate_across_items");
        }
        if (duplicate) await recordFullTextMiss(article, "failed", "duplicate_across_items");
        return duplicate;
    };
}

/**
 * "auto" full-text mode: fetches each candidate article's source page and runs
 * it through the readability extraction engine (ensemble + quality gate +
 * escalation chain), storing the result as either HTML or Markdown per the
 * feed's `defaultContentFormat` — but only when it is clearly better than the
 * feed-provided content (`decideFullText`). Selector mode uses the same fetch
 * pipeline with CSS extraction in the HTML worker.
 */
async function autoFetchFullTextViaEngine(
    userId: string,
    articleIds: string[],
    feed: {
        id: string;
        defaultContentFormat?: string | null;
        fullTextSelector?: string | null;
        contentRules?: string | null;
        fullTextRemoveSelectors?: string | null;
    },
    mode: "auto" | "ai" | "selector" = "auto",
) {
    const articles = await loadFullTextCandidates(userId, articleIds);
    if (articles.length === 0) return;
    const isDuplicate = duplicateGuard(userId, feed.id);

    // The hosted-API BYOK connector (M7-T3) sends article content to a third
    // party, so unlike the manual "Fetch full text" button it must never run
    // during unattended background sync unless the user explicitly opted in.
    const user = await db.user.findUnique({
        where: { id: userId },
        select: {
            contentFetchAutoUse: true,
            aiProvider: true,
            aiApiKey: true,
            aiModel: true,
            aiOllamaBaseUrl: true,
        },
    });
    const baseExtractOptions = user?.contentFetchAutoUse ? { userId } : {};

    // M6: per-feed opt-in AI-extraction, capped per sync CALL (not per
    // article) — a feed's initial backfill can land dozens of articles in one
    // batch, and this bounds how many of those spend the user's own AI tokens
    // in a single tick. `articleIds` only contains new, upstream-changed or
    // retryable rows (ArticleSyncResult.fullTextCandidateIds).
    const aiConfig: MeteredAiConfig | null =
        mode === "ai" && user?.aiProvider
            ? {
                  provider: user.aiProvider as AiConfig["provider"],
                  apiKey: decryptIfValue(user.aiApiKey, "user.aiApiKey"),
                  model: user.aiModel,
                  ollamaBaseUrl: user.aiOllamaBaseUrl,
                  usage: { userId, feature: "extraction" },
              }
            : null;
    // Escalation tiers are bounded per sync call: AI (also metered against the
    // user's daily token cap by runAiPrompt/reserveBudget), the render sidecar
    // and the hosted API each get a fixed number of uses; a tier whose budget
    // is spent is skipped for the remaining articles of this sync. The budget
    // is decremented only when a tier actually runs.
    const escalationBudget: EscalationBudget = {
        ai: aiConfig ? MAX_AI_EXTRACTIONS_PER_SYNC_BATCH : 0,
        render: MAX_RENDER_ESCALATIONS_PER_SYNC,
        hosted: MAX_HOSTED_ESCALATIONS_PER_SYNC,
    };

    for (const article of articles) {
        if (!article.link) continue;
        try {
            if (await deferIfHostBackingOff(article)) continue;
            const baselineHtml = feedBaseline(article);
            const extractOptions = {
                ...baseExtractOptions,
                ...(mode === "selector" ? { selector: feed.fullTextSelector ?? null, removeSelectors: feed.fullTextRemoveSelectors } : {}),
                ...(aiConfig ? { aiExtraction: aiConfig } : {}),
                escalationBudget,
                baselineHtml,
                gate: "auto" as const,
            };

            let result: Awaited<ReturnType<typeof fetchAndExtractReadable>>;
            try {
                result = await fetchAndExtractReadable(article.link, extractOptions);
            } catch (error) {
                // Fetch failed on every tier: keep whatever content the article has.
                if (error instanceof EscalationBudgetExhaustedError) {
                    // Not a real failure: a tier was skipped for this sync's budget.
                    await recordFullTextMiss(article, "deferred", "budget");
                    continue;
                }
                await recordFullTextFetchError(article, error);
                continue;
            }

            if (!result.html && result.parseAborted) {
                // The page could not be parsed within the HTML worker's limits
                // (lib/html-worker): a hard failure (counts towards the retry cap),
                // or a saturated pool (retry next sync).
                await recordParseAborted(article, result.parseAborted);
                continue;
            }
            if (result.html && (feed.contentRules || feed.fullTextRemoveSelectors)) {
                const [clean] = await applyFeedContentRules([{ title: "", html: result.html }], feed.contentRules, feed.fullTextRemoveSelectors);
                result = { ...result, html: clean.html, excerpt: clean.excerpt, markdown: null, quality: assessExtraction(clean.html) };
            }
            const decision = decideFullText(result.quality, baselineHtml, "auto", result.html);
            if ((!decision.accept || !result.html) && result.budgetSkipped) {
                // Escalation was cut short by the per-sync budget: retry next sync
                // instead of recording a final "rejected".
                await recordFullTextMiss(article, "deferred", "budget");
                continue;
            }
            if ((!decision.accept || !result.html) && result.renderDeferred) {
                await recordFullTextMiss(article, "deferred", "render_unavailable");
                continue;
            }
            if (!decision.accept || !result.html) {
                await recordFullTextMiss(article, "rejected", decision.accept ? "empty" : decision.reason);
                continue;
            }

            if (await isDuplicate(article, result.html)) continue;

            const useMarkdown = feed.defaultContentFormat === "markdown" && !!result.markdown;
            await storeFullText(article, {
                content: useMarkdown ? result.markdown! : result.html,
                format: useMarkdown ? "markdown" : "html",
                excerpt: result.excerpt,
            });
        } catch (e) {
            logger.warn(`[rss-sync] autoFetchFullTextViaEngine failed for ${urlForLog(article.link)}:`, e);
        }
    }
}

async function autoSummarizeNewArticles(userId: string, articleIds: string[]) {
    const user = await db.user.findUnique({
        where: { id: userId },
        select: {
            aiAutoSummarize: true,
            aiProvider: true,
            aiApiKey: true,
            aiModel: true,
            aiOllamaBaseUrl: true,
            aiSummaryLanguage: true,
        },
    });

    if (!user?.aiAutoSummarize || !user.aiProvider) return;

    const { generateSummary } = await import("./ai-summary");

    const articles = await db.article.findMany({
        where: {
            id: { in: articleIds },
            userId,
            isDuplicate: false,
            aiSummary: null,
        },
        orderBy: { createdAt: "asc" },
        select: { id: true, content: true },
        take: MAX_AUTO_SUMMARIES_PER_SYNC,
    });

    for (const article of articles) {
        const content = article.content?.trim();
        if (!content) continue;

        try {
            const summary = await generateSummary(content, {
                provider: user.aiProvider as AiConfig["provider"],
                apiKey: decryptIfValue(user.aiApiKey, "user.aiApiKey"),
                model: user.aiModel,
                ollamaBaseUrl: user.aiOllamaBaseUrl,
                language: user.aiSummaryLanguage,
                usage: { userId, feature: "summary" },
            });

            await db.article.update({
                where: { id: article.id },
                data: { aiSummary: summary, aiSummarizedAt: new Date() },
            });
        } catch (error) {
            // Daily token cap reached: every further article would be refused too.
            if (error instanceof AiBudgetError) {
                warnBudgetOnce(userId, "auto-summary", error);
                break;
            }
            logger.error("[rss-sync] auto-summary failed:", error);
        }
    }
}

export async function autoTagNewArticles(
    userId: string,
    articleIds: string[],
    options: { applyRules?: boolean } = {},
) {
    const applyRules = options.applyRules ?? true;
    const user = await db.user.findUnique({
        where: { id: userId },
        select: {
            aiAutoTag: true,
            aiProvider: true,
            aiApiKey: true,
            aiModel: true,
            aiOllamaBaseUrl: true,
        },
    });

    if (!user?.aiAutoTag || !user.aiProvider) return;

    const { generateEnrichment } = await import("./ai-tagging");

    const articles = await db.article.findMany({
        where: {
            id: { in: articleIds },
            userId,
            isDuplicate: false,
            aiTaggedAt: null,
        },
        orderBy: { createdAt: "asc" },
        select: { id: true, title: true, content: true },
        take: MAX_AUTO_TAG_PER_SYNC,
    });

    if (articles.length === 0) return;

    // Nudges the model toward reusing existing tags instead of minting
    // near-duplicates (e.g. "AI" vs "Artificial Intelligence") each sync.
    const existingLabels = await db.label.findMany({
        where: { userId },
        select: { name: true },
        orderBy: { name: "asc" },
    });
    const existingLabelNames = existingLabels.map((label) => label.name);

    const aiConfig: AiConfig = {
        provider: user.aiProvider as AiConfig["provider"],
        apiKey: decryptIfValue(user.aiApiKey, "user.aiApiKey"),
        model: user.aiModel,
        ollamaBaseUrl: user.aiOllamaBaseUrl,
        usage: { userId, feature: "tagging" },
    };

    // Articles that received AI enrichment: auto-read rules (`is:sponsored`,
    // `is:clickbait`, `entity:`) must see the final flags/entities.
    const enrichedIds: string[] = [];

    for (const article of articles) {
        const content = article.content?.trim();
        if (!content) continue;

        try {
            // ONE AI call per article: tags + entities + sponsored/clickbait/cleanTitle.
            const enrichment = await generateEnrichment(article.title, content, aiConfig, existingLabelNames);
            const tagNames = enrichment.tags;
            let labelsAdded = false;

            for (const name of tagNames) {
                let label = await db.label.findFirst({ where: { userId, name } });
                if (!label) {
                    label = await db.label.create({ data: { userId, name } });
                    existingLabelNames.push(name);
                }
                const alreadyLinked = await db.articleLabel.findUnique({
                    where: { articleId_labelId: { articleId: article.id, labelId: label.id } },
                });
                if (!alreadyLinked) {
                    await db.articleLabel.create({
                        // "ai": the briefing ranks only user labels as a signal (lib/briefing/select.ts).
                        data: { articleId: article.id, labelId: label.id, userId, source: "ai" },
                    });
                    labelsAdded = true;
                }
            }

            // aiTaggedAt + enrichment in one write. Keeps Article.updatedAt (GReader
            // ot/nt clock) unless NEW label assignments were created: those are
            // visible to GReader clients as category tags and must be picked up
            // by incremental syncs — see lib/article-enrichment.ts.
            const result = await persistEnrichment(article.id, userId, enrichment, {
                bumpUpdatedAt: labelsAdded,
            });
            if (!result.written) {
                logger.warn("[rss-sync] enrichment write skipped (article changed concurrently):", article.id);
            } else if (enrichment.structured) {
                enrichedIds.push(article.id);
            }
        } catch (error) {
            if (error instanceof AiBudgetError) {
                warnBudgetOnce(userId, "auto-tag", error);
                break;
            }
            logger.error("[rss-sync] auto-tag failed:", error);
        }
    }

    if (applyRules && enrichedIds.length > 0) {
        await applyAutoReadRules(userId, { onlyArticleIds: enrichedIds }).catch((e) =>
            logger.error("[rss-sync] applyAutoReadRules after enrichment failed:", e),
        );
    }
}

/**
 * Bulk syncs (all of a user's feeds: the reader's boot sync, "refresh all";
 * every feed: the scheduler) queue their HTML parsing as BACKGROUND work, so a
 * user waiting on one page (manual full text, previews) is served first.
 * Single-feed syncs (add feed, "refresh this feed") stay interactive.
 */
export function syncUserFeeds(userId: string, options: { background?: boolean } = {}) {
    return runAsBackgroundHtmlWork(() => syncUserFeedsNow(userId, options.background ?? false));
}

type BackgroundFeed = { id: string; userId: string; url: string; autoMuted?: boolean };
function syncBudgetMs() {
    const configured = Number(process.env.SYNC_ALL_BUDGET_MS);
    return Number.isFinite(configured) && configured > 0 ? configured : 240_000;
}
type BackgroundResult = { feed: string; success: boolean; skipped?: boolean; deferred?: boolean; deferredReason?: string; count?: number; error?: string; createdArticleIds?: string[] };
async function syncBackgroundFeedQueues(feeds: BackgroundFeed[], deadline: number, deferAutoReadRules = false) {
    const secretRules = await getConnectorSecretRules();
    const publicUrl = (feed: BackgroundFeed) => stripConnectorSecretsWith(secretRules, feed.url);
    const activeResults = await drainHostQueues<BackgroundFeed, BackgroundResult>(feeds.filter(feed => !feed.autoMuted), {
        concurrency: getSyncConcurrency(), deadline, spacingMs: hostSpacingMs(), spacingRemaining: hostSpacingRemainingMs,
        run: async (feed) => {
            if (feed.autoMuted) return { result: { feed: publicUrl(feed), success: true, skipped: true, count: 0 } };
            let res: Awaited<ReturnType<typeof syncFeed>>;
            try {
                res = await syncFeed(feed.userId, feed.id, { background: true, retryBusyHostInRun: true, deferAutoReadRules });
            } catch (error) {
                // One feed (e.g. deleted during the run) must not abort the run and strand the other leftovers.
                // Programming errors still surface.
                if (error instanceof TypeError || error instanceof ReferenceError || error instanceof SyntaxError) throw error;
                logger.error(`[rss-sync] background sync of feed ${feed.id} failed:`, error);
                return { result: { feed: publicUrl(feed), success: false, error: redactConnectorTextWith(secretRules, error instanceof Error ? error.message : String(error)) } };
            }
            const reason = "deferredReason" in res ? res.deferredReason : undefined;
            const waitMs = "retryAfterMs" in res ? res.retryAfterMs : undefined;
            // Busy: another run owns the lane, retry this feed. Backoff (429/503/Retry-After, incl. a plain 503
            // that does not mark discovery/full-text rate-limited): pause this host's lane for the rest of the run.
            return { result: { feed: publicUrl(feed), ...res }, ...(reason === "host_busy" ? { retryAfterMs: waitMs } : reason === "host_backoff" ? { pauseMs: waitMs } : {}) };
        },
        defer: async (feed, waitMs) => {
            // A lane that frees up right away leaves the feed due as it is: no scheduling write needed.
            if (waitMs > 1000) await db.feed.updateMany({ where: { id: feed.id }, data: { nextSyncAt: deferredSyncAt(waitMs) } });
            return { feed: publicUrl(feed), success: true, skipped: true, deferred: true, deferredReason: "sync_budget", count: 0 };
        },
    });
    let index = 0;
    return feeds.map(feed => feed.autoMuted ? { feed: publicUrl(feed), success: true, skipped: true, count: 0 } : activeResults[index++]);
}

/**
 * "Refresh all" (sync action, API v1, MCP) keeps its pre-adaptive rule: a feed is refetched once its configured
 * interval (Google News floor/backoff included) has passed since the last fetch. A single-feed refresh bypasses it.
 */
async function userRefreshDueFeeds(userId: string) {
    const user = await db.user.findUnique({ where: { id: userId }, select: { defaultUpdateFrequency: true } });
    const userDefaultUpdateFrequency = user?.defaultUpdateFrequency ?? 60;
    const feeds = await db.feed.findMany({
        where: { userId, archivedAt: null, sourceType: { not: NEWSLETTER_SOURCE_TYPE } },
        select: {
            id: true, userId: true, url: true, autoMuted: true, updateFrequency: true, lastFetchedAt: true, consecutiveFailureCount: true,
            category: { select: { parentId: true, updateFrequency: true, parent: { select: { updateFrequency: true } } } },
        },
    });
    const now = Date.now();
    return feeds.filter((feed) => {
        if (feed.autoMuted || !feed.lastFetchedAt) return true;
        const minutes = politeUpdateFrequency(feed, computeEffectiveUpdateFrequency(feed, userDefaultUpdateFrequency));
        return (now - feed.lastFetchedAt.getTime()) / 60_000 >= minutes;
    });
}

/** The reader-boot request waits on this run: keep it short; leftovers keep staggered schedules for the server run. */
const USER_BACKGROUND_BUDGET_MS = 30_000;

async function syncUserFeedsNow(userId: string, background: boolean) {
    const deadline = Date.now() + Math.min(syncBudgetMs(), USER_BACKGROUND_BUDGET_MS);
    await syncDynamicOpmlCategories(userId).catch((e) =>
        logger.error("[rss-sync] dynamic OPML sync failed:", e),
    );

    // Archived feeds are never fetched in bulk (restore re-enables them).
    const feeds = background
        ? await db.feed.findMany({ where: { userId, ...dueFeedWhere() }, select: { id: true, userId: true, url: true, autoMuted: true } })
        : await userRefreshDueFeeds(userId);

    // Results reach clients (sync action, API v1, MCP): no connector secrets.
    const secretRules = await getConnectorSecretRules();
    const results = background ? await syncBackgroundFeedQueues(feeds, deadline, true) : await mapWithConcurrency(feeds, getSyncConcurrency(), async (rawFeed) => {
        const feed = { ...rawFeed, url: stripConnectorSecretsWith(secretRules, rawFeed.url) };
        // F6: an auto-muted feed is deliberately not actively re-fetched
        // by background sync (stop wasting cycles hitting a dead URL) —
        // a manual "Refresh now" (syncFeed called directly) still works
        // and gives it a chance to self-recover.
        if (feed.autoMuted) {
            return { feed: feed.url, success: true, skipped: true, count: 0 };
        }

        const res = await syncFeed(feed.userId, feed.id, { deferAutoReadRules: true, background });
        return { feed: feed.url, ...res };
    });

    const hasSynced = results.some((r: any) => r.success && !r.skipped);
    if (hasSynced) {
        await applyAutoReadRules(userId).catch((e) =>
            logger.error("[rss-sync] applyAutoReadRules failed:", e),
        );
    }

    return results;
}

export function syncAllFeeds() {
    return runAsBackgroundHtmlWork(() => syncAllFeedsNow());
}

async function syncAllFeedsNow() {
    const startedAt = Date.now();
    const budgetMs = syncBudgetMs();
    await syncDynamicOpmlCategories().catch((e) =>
        logger.error("[rss-sync] dynamic OPML sync failed:", e),
    );

    const feeds = await db.feed.findMany({
        where: dueFeedWhere(),
        orderBy: [{ nextSyncAt: { sort: "asc", nulls: "first" } }, { id: "asc" }],
        select: { id: true, userId: true, url: true, autoMuted: true },
    });

    const results = await syncBackgroundFeedQueues(feeds, startedAt + budgetMs);
    const deferred = results.filter(result => "deferredReason" in result && result.deferredReason === "sync_budget").length;

    if (deferred) await writeSystemLog("warn", "sync", "Feed sync budget exhausted; remaining feeds deferred", { deferred, budgetMs });
    return results;
}

/**
 * G1: Google News throttles aggressive pollers (429 / "unusual traffic"), so
 * its feeds are polled at most every GOOGLE_NEWS_MIN_UPDATE_MINUTES and back
 * off exponentially after consecutive failures (x2 per failure, capped at
 * 16x / 24 h). Other feeds are unaffected.
 */
export function politeUpdateFrequency(
    feed: { url: string; consecutiveFailureCount?: number | null },
    minutes: number,
): number {
    if (!isGoogleNewsFeedUrl(feed.url)) return minutes;
    const base = Math.max(minutes, GOOGLE_NEWS_MIN_UPDATE_MINUTES);
    const failures = Math.max(0, Math.min(4, feed.consecutiveFailureCount ?? 0));
    return Math.min(base * 2 ** failures, 24 * 60);
}

type FrequencyResolutionFeed = {
    updateFrequency: number | null;
    category: {
        parentId: string | null;
        updateFrequency: number | null;
        parent: { updateFrequency: number | null } | null;
    } | null;
};

/**
 * Mirrors `getEffectiveSettings`'s resolution hierarchy (Feed -> Subcategory -> Category ->
 * User Global -> Site Default) but works off data already loaded in the outer feed query,
 * so the sync loop doesn't re-fetch each feed's settings.
 */
function computeEffectiveUpdateFrequency(
    feed: FrequencyResolutionFeed,
    userDefaultUpdateFrequency: number,
): number {
    // 1. Feed level
    if (feed.updateFrequency !== null) {
        return feed.updateFrequency;
    }

    // 2. Subcategory level (if category has parent)
    if (feed.category && feed.category.parentId) {
        if (feed.category.updateFrequency !== null) {
            return feed.category.updateFrequency;
        }
    }

    // 3. Category level (top-level or parent)
    if (feed.category) {
        const topLevelFrequency = feed.category.parentId
            ? feed.category.parent?.updateFrequency
            : feed.category.updateFrequency;

        if (topLevelFrequency !== null && topLevelFrequency !== undefined) {
            return topLevelFrequency;
        }
    }

    // 4. User global level
    if (userDefaultUpdateFrequency) {
        return userDefaultUpdateFrequency;
    }

    // 5. Site default
    return 60;
}

