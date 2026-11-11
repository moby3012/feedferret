import { db } from "@/lib/db";
import { articleMatchesContentFilter } from "@/lib/feed-content-filter";
import { translateFreshRssReadFilters } from "@/lib/import/frss-filters";

/**
 * Full-text conditions (`Feed.fullTextConditions`, FreshRSS `frss:cssFullContentConditions`):
 * one search expression per line; full text is fetched only for articles matching any line.
 *
 * The lines use FreshRSS search syntax and are translated with the same exact-only
 * translator as the FreshRSS read filters. When a line cannot be translated the
 * condition set cannot be evaluated faithfully, so every candidate is kept — fetching
 * too much costs a request, skipping an article the user wanted in full would lose content.
 */
export function compileFullTextConditions(raw: string | null | undefined) {
    if (!raw?.trim()) return null;
    const translation = translateFreshRssReadFilters(raw);
    if (translation.unsupported.length) return null;
    if (!translation.keywordLines.length && !translation.ruleQueries.length) return null;
    return {
        keywords: translation.keywordLines.map((line) => line.toLowerCase()),
        queries: translation.ruleQueries,
    };
}

export async function filterByFullTextConditions(
    userId: string,
    candidateIds: string[],
    conditions: string | null | undefined,
): Promise<string[]> {
    const compiled = compileFullTextConditions(conditions);
    if (!compiled || candidateIds.length === 0) return candidateIds;

    const matched = new Set<string>();
    if (compiled.keywords.length) {
        const rows = await db.article.findMany({
            where: { userId, id: { in: candidateIds } },
            select: { id: true, title: true, excerpt: true, content: true },
        });
        for (const row of rows) if (articleMatchesContentFilter(row, compiled.keywords)) matched.add(row.id);
    }
    // Lazy: the search module reads the DB provider at load time.
    const { buildAdvancedSearchWhere } = compiled.queries.length ? await import("@/lib/search") : { buildAdvancedSearchWhere: null };
    for (const query of compiled.queries) {
        const remaining = candidateIds.filter((id) => !matched.has(id));
        if (!remaining.length) break;
        const where = await buildAdvancedSearchWhere!(userId, query);
        const rows = await db.article.findMany({
            where: { AND: [where, { userId, id: { in: remaining } }] },
            select: { id: true },
        });
        for (const row of rows) matched.add(row.id);
    }
    return candidateIds.filter((id) => matched.has(id));
}
