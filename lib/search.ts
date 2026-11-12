import { db, getDatabaseProvider } from "./db";
import { isSqliteFtsReady } from "./search-indexes";

// PostgreSQL's LIKE is case-sensitive; Prisma supports mode:'insensitive' (ILIKE) there.
// SQLite's LIKE is already case-insensitive for ASCII and does NOT support mode:'insensitive'.
const isPostgres = getDatabaseProvider() === "postgresql";
function ci(value: string) {
    return isPostgres
        ? ({ contains: value, mode: "insensitive" as const })
        : ({ contains: value });
}

// ── SQLite FTS5 acceleration for free-text terms (see lib/search-indexes.ts) ──
//
// On Postgres, pg_trgm GIN indexes on ArticleSearch accelerate
// ILIKE '%term%' queries fast with no query-logic change, so the free-text
// loop below always uses the plain LIKE/ILIKE branch for that provider.
//
// On SQLite, article_fts is an FTS5 table using the `trigram` tokenizer,
// which — unlike SQLite's default tokenizers — matches arbitrary substrings
// the same way LIKE '%term%' does (case-insensitively), so swapping a term's
// title/content/excerpt/author matching over to an `id IN (...)` lookup
// against the FTS index preserves the current matching semantics rather than
// switching to word-based matching. `link` and feed/label names aren't in
// the FTS index, so those stay on the LIKE path and are OR'd together with
// the FTS id-set, exactly preserving "term matches ANY of title/content/
// excerpt/author/link/feed.name/label.name".
//
// Two situations make FTS unusable for a given term, and both fall back to
// the original full LIKE-based condition (never a *narrower* result set):
//   - The trigram tokenizer cannot index substrings shorter than 3 characters,
//     so terms under that length skip FTS entirely.
//   - The FTS table/triggers don't exist yet (e.g. ensureSearchIndexes()
//     hasn't run, or failed and logged a warning) — any query error against
//     article_fts is caught and treated as "FTS unavailable".
const MIN_FTS_TERM_LENGTH = 3;

// Builds a literal FTS5 phrase query for a single term: wraps it in double
// quotes so none of the term's characters (: - * etc.) are parsed as FTS5
// query syntax, and doubles any embedded double quotes (FTS5's own escaping
// rule for quoted strings) so the term is matched as an exact literal
// substring rather than being split into a boolean expression.
export function buildFtsMatchQuery(term: string): string {
    return `"${term.replace(/"/g, '""')}"`;
}

// Prisma refuses a query with more bind variables than the driver allows (P2029 → HTTP 500).
// For SQLite that limit is 999 in Prisma 7: the client falls back to SQLite's historical
// default because @prisma/adapter-better-sqlite3 does not report its own (higher) limit.
// The FTS hit list is passed to Prisma as `id IN (…)`, so ALL free-text terms of one query
// together must stay well below that, next to the LIKE/filter parameters of the rest of the
// query. Per term we therefore accept at most MAX_FTS_IDS_PER_TERM hits (and at most
// FTS_ID_BUDGET / tokens when a query has several). A term with more matches than that is not
// "refined" or truncated: it simply takes the LIKE path below, which has no list to bind, so
// results stay complete for any term. Broad terms hit on page one quickly via the publishedAt
// index; only their exact total (count) costs a scan. (Before this was sized to 32 766, so a
// term with ~1 000–5 000 hits failed with P2029.)
const MAX_FTS_IDS_PER_TERM = 500;
const FTS_ID_BUDGET = 500;

// Upper bounds for one search query (follow-up to #243). Every token can become a free-text
// term with its own `id IN (…)` share and ~8 LIKE parameters, so an unbounded query (a pasted
// article, an API client) could push the statement past the bind-variable limit and SQLite's
// expression depth, or a single huge term past SQLITE_MAX_LIKE_PATTERN_LENGTH (50 000 bytes)
// → HTTP 500. Worst case with these caps: 500 ids + 24 × 8 LIKE params ≈ 700 binds, leaving
// room for the caller's own filters. Tokens beyond the cap are ignored (the query only gets
// broader, never wrong or failing).
export const MAX_SEARCH_QUERY_LENGTH = 1000;
export const MAX_SEARCH_TOKENS = 24;

/**
 * Ids of the user's articles matching `term` in the SQLite FTS index, or null when the
 * caller must use the plain LIKE path: Postgres, term < 3 chars, index missing/still
 * being backfilled, or more than `cap` matches. Scoped to `userId` in SQL so other
 * users' hits never count against the cap.
 */
async function ftsMatchIds(userId: string, term: string, cap: number): Promise<string[] | null> {
    if (isPostgres) return null;
    if (Array.from(term).length < MIN_FTS_TERM_LENGTH) return null;

    try {
        if (!(await isSqliteFtsReady())) return null;
        const rows = await db.$queryRawUnsafe<{ id: string }[]>(
            `SELECT a.id AS id FROM "ArticleSearch" s JOIN "Article" a ON a.id = s.id
             WHERE a.userId = ? AND s.rowid IN (SELECT rowid FROM article_fts WHERE article_fts MATCH ?)
             LIMIT ?`,
            userId,
            buildFtsMatchQuery(term),
            cap + 1
        );
        if (rows.length > cap) return null;
        return rows.map((row) => row.id);
    } catch {
        // article_fts missing/broken — fall back to the unaccelerated query.
        return null;
    }
}

async function buildFreeTextCondition(userId: string, term: string, ftsCap: number): Promise<object> {
    const ftsIds = await ftsMatchIds(userId, term, ftsCap);
    if (ftsIds !== null) {
        return {
            OR: [
                { id: { in: ftsIds } },
                { link: ci(term) },
                { feed: { name: ci(term) } },
                { labels: { some: { label: { name: ci(term), userId } } } },
            ],
        };
    }

    return {
        OR: [
            { search: { is: { OR: [
                { title: ci(term) },
                { content: ci(term) },
                { excerpt: ci(term) },
                { author: ci(term) },
            ] } } },
            { link: ci(term) },
            { feed: { name: ci(term) } },
            { labels: { some: { label: { name: ci(term), userId } } } },
        ],
    };
}

export function tokenizeSearch(query: string) {
    const tokens: string[] = [];
    // `key:"two words"` / `-key:'two words'` stay ONE token (value unquoted), so
    // `entity:"Angela Merkel"` and `author:"Jane Doe"` work like their one-word forms.
    // eslint-disable-next-line regexp/no-super-linear-move -- the `(\S+)` branch consumes any run the keyed branches reject; covered by tests/security/redos-regression.test.ts
    const re = /([-!]?[A-Za-z]+:)(?:"([^"]+)"|'([^']+)')|"([^"]+)"|'([^']+)'|(\S+)/g;
    let match: RegExpExecArray | null;
    while ((match = re.exec(query)) !== null) {
        if (match[1]) tokens.push(match[1] + (match[2] || match[3]));
        else tokens.push(match[4] || match[5] || match[6]);
    }
    return tokens;
}

export function parseDateToken(value: string) {
    const now = new Date();
    const relative = value.match(/^(\d+)(d|w|m|y)$/i);
    if (relative) {
        const amount = Number(relative[1]);
        const unit = relative[2].toLowerCase();
        const date = new Date(now);
        if (unit === "d") date.setDate(date.getDate() - amount);
        if (unit === "w") date.setDate(date.getDate() - amount * 7);
        if (unit === "m") date.setMonth(date.getMonth() - amount);
        if (unit === "y") date.setFullYear(date.getFullYear() - amount);
        return date;
    }
    const parsed = new Date(value);
    return Number.isNaN(parsed.getTime()) ? null : parsed;
}

async function processGroupTokens(userId: string, tokens: string[], ftsCap: number): Promise<object> {
    const and: any[] = [];
    const freeText: string[] = [];

    for (const rawToken of tokens) {
        const negated = rawToken.startsWith("-") || rawToken.startsWith("!");
        const token = negated ? rawToken.slice(1) : rawToken;
        const [rawKey, ...rest] = token.split(":");
        const hasField = rest.length > 0;
        const key = rawKey.toLowerCase();
        const value = hasField ? rest.join(":").trim() : token.trim();
        if (!value) continue;

        let condition: any | null = null;
        let searchText = false;
        // Nullable tri-state flags: `NOT (col = true)` is NULL (= excluded) for
        // unknown rows in SQL, so their negation is spelled out explicitly.
        let negatedCondition: any | null = null;

        if (token.startsWith("#")) {
            condition = {
                labels: {
                    some: {
                        label: {
                            userId,
                            name: ci(token.slice(1)),
                        },
                    },
                },
            };
        } else if (hasField) {
            if (["author", "by"].includes(key)) {
                condition = { author: ci(value) };
                searchText = true;
            } else if (["intitle", "title"].includes(key)) {
                condition = { title: ci(value) };
                searchText = true;
            } else if (["intext", "text", "content"].includes(key)) {
                condition = {
                    OR: [
                        { content: ci(value) },
                        { excerpt: ci(value) },
                    ],
                };
                searchText = true;
            } else if (["inurl", "url", "link"].includes(key)) {
                condition = { link: ci(value) };
            } else if (["feed", "f"].includes(key)) {
                condition = {
                    feed: {
                        OR: [
                            { id: value },
                            { name: ci(value) },
                            { url: ci(value) },
                        ],
                    },
                };
            } else if (["category", "cat", "c"].includes(key)) {
                condition = {
                    feed: {
                        category: {
                            OR: [
                                { id: value },
                                { name: ci(value) },
                            ],
                        },
                    },
                };
            } else if (["label", "tag"].includes(key)) {
                condition = {
                    labels: {
                        some: {
                            label: {
                                userId,
                                OR: [
                                    { id: value },
                                    { name: ci(value) },
                                ],
                            },
                        },
                    },
                };
            } else if (key === "is" || key === "status") {
                const normalized = value.toLowerCase();
                if (["unread", "new"].includes(normalized)) condition = { isRead: false };
                if (["read"].includes(normalized)) condition = { isRead: true };
                if (["starred", "favorite", "favourite"].includes(normalized)) condition = { isStarred: true };
                if (["unstarred"].includes(normalized)) condition = { isStarred: false };
                if (["readlater", "later", "saved", "toread"].includes(normalized)) condition = { isReadLater: true };
                // K3 enrichment flags (nullable: null = unknown, so `-is:sponsored` keeps unknown rows).
                if (["sponsored", "ad", "ads", "anzeige", "werbung"].includes(normalized)) {
                    condition = { isSponsored: true };
                    negatedCondition = { OR: [{ isSponsored: null }, { isSponsored: false }] };
                }
                if (["clickbait"].includes(normalized)) {
                    condition = { isClickbait: true };
                    negatedCondition = { OR: [{ isClickbait: null }, { isClickbait: false }] };
                }
            } else if (["entity", "entities", "ent"].includes(key)) {
                // `entities` is a JSON string[] column: match the quoted element so
                // `entity:EZB` does not hit "EZB-Chefin". Quotes/backslashes cannot
                // occur in stored entities (sanitized at write time).
                const entity = value.replace(/["\\]/g, "").trim();
                if (entity) {
                    searchText = true;
                    condition = { entities: ci(`"${entity}"`) };
                    // Articles without enrichment have entities = NULL and must survive `-entity:X`.
                    negatedCondition = { OR: [{ entities: null }, { NOT: condition }] };
                }
            } else if (["after", "since"].includes(key)) {
                const date = parseDateToken(value);
                if (date) condition = { publishedAt: { gte: date } };
            } else if (["before", "until"].includes(key)) {
                const date = parseDateToken(value);
                if (date) condition = { publishedAt: { lte: date } };
            } else if (key === "date" || key === "pubdate") {
                const date = parseDateToken(value);
                if (date) condition = { publishedAt: { gte: date } };
            }
        }

        if (!condition) {
            freeText.push(value);
            continue;
        }

        const predicate = negated ? (negatedCondition ?? { NOT: condition }) : condition;
        // Keep NOT inside the relation: SQL NULL author/content semantics must stay identical.
        and.push(searchText ? { search: { is: predicate } } : predicate);
    }

    const freeTextConditions = await Promise.all(
        freeText.map((term) => buildFreeTextCondition(userId, term, ftsCap))
    );
    and.push(...freeTextConditions);

    return and.length ? { AND: and } : {};
}

export async function buildAdvancedSearchWhere(userId: string, query?: string) {
    if (!query?.trim()) return {};

    const allTokens = tokenizeSearch(query.trim().slice(0, MAX_SEARCH_QUERY_LENGTH)).slice(0, MAX_SEARCH_TOKENS);
    // Every token may become a free-text term; share the bind-variable budget between them.
    const ftsCap = Math.min(MAX_FTS_IDS_PER_TERM, Math.floor(FTS_ID_BUDGET / Math.max(1, allTokens.length)));

    // Split token list by "OR" (case-insensitive, exact token match) into groups
    const groups: string[][] = [];
    let current: string[] = [];
    for (const tok of allTokens) {
        if (tok.toUpperCase() === "OR") {
            groups.push(current);
            current = [];
        } else {
            current.push(tok);
        }
    }
    groups.push(current);

    // Filter out empty groups (handles leading/trailing OR)
    const nonEmptyGroups = groups.filter(g => g.length > 0);

    if (nonEmptyGroups.length === 0) return {};
    if (nonEmptyGroups.length === 1) return processGroupTokens(userId, nonEmptyGroups[0], ftsCap);

    // Multiple groups: process each and OR the results
    const allResults = await Promise.all(nonEmptyGroups.map(g => processGroupTokens(userId, g, ftsCap)));
    const results = allResults.filter(r => Object.keys(r).length > 0);

    if (results.length === 0) return {};
    if (results.length === 1) return results[0];
    return { OR: results };
}
