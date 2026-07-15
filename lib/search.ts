import { db, getDatabaseProvider } from "./db";

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
// On Postgres we change nothing here: pg_trgm GIN indexes make the existing
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

async function ftsMatchIds(term: string): Promise<string[] | null> {
    if (isPostgres) return null;
    if (Array.from(term).length < MIN_FTS_TERM_LENGTH) return null;

    try {
        const rows = await db.$queryRawUnsafe<{ id: string }[]>(
            `SELECT id FROM article_fts WHERE article_fts MATCH ?`,
            buildFtsMatchQuery(term)
        );
        return rows.map((row) => row.id);
    } catch {
        // article_fts missing/broken — fall back to the unaccelerated query.
        return null;
    }
}

async function buildFreeTextCondition(userId: string, term: string): Promise<object> {
    const ftsIds = await ftsMatchIds(term);
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
            { title: ci(term) },
            { content: ci(term) },
            { excerpt: ci(term) },
            { author: ci(term) },
            { link: ci(term) },
            { feed: { name: ci(term) } },
            { labels: { some: { label: { name: ci(term), userId } } } },
        ],
    };
}

export function tokenizeSearch(query: string) {
    const tokens: string[] = [];
    const re = /"([^"]+)"|'([^']+)'|(\S+)/g;
    let match: RegExpExecArray | null;
    while ((match = re.exec(query)) !== null) {
        tokens.push(match[1] || match[2] || match[3]);
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

async function processGroupTokens(userId: string, tokens: string[]): Promise<object> {
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
            } else if (["intitle", "title"].includes(key)) {
                condition = { title: ci(value) };
            } else if (["intext", "text", "content"].includes(key)) {
                condition = {
                    OR: [
                        { content: ci(value) },
                        { excerpt: ci(value) },
                    ],
                };
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

        and.push(negated ? { NOT: condition } : condition);
    }

    const freeTextConditions = await Promise.all(
        freeText.map((term) => buildFreeTextCondition(userId, term))
    );
    and.push(...freeTextConditions);

    return and.length ? { AND: and } : {};
}

export async function buildAdvancedSearchWhere(userId: string, query?: string) {
    if (!query?.trim()) return {};

    const allTokens = tokenizeSearch(query.trim());

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
    if (nonEmptyGroups.length === 1) return processGroupTokens(userId, nonEmptyGroups[0]);

    // Multiple groups: process each and OR the results
    const allResults = await Promise.all(nonEmptyGroups.map(g => processGroupTokens(userId, g)));
    const results = allResults.filter(r => Object.keys(r).length > 0);

    if (results.length === 0) return {};
    if (results.length === 1) return results[0];
    return { OR: results };
}
