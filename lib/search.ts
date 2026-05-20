import { db } from "./db";

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

function processGroupTokens(userId: string, tokens: string[]): object {
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
                            name: { contains: token.slice(1) },
                        },
                    },
                },
            };
        } else if (hasField) {
            if (["author", "by"].includes(key)) {
                condition = { author: { contains: value } };
            } else if (["intitle", "title"].includes(key)) {
                condition = { title: { contains: value } };
            } else if (["intext", "text", "content"].includes(key)) {
                condition = {
                    OR: [
                        { content: { contains: value } },
                        { excerpt: { contains: value } },
                    ],
                };
            } else if (["inurl", "url", "link"].includes(key)) {
                condition = { link: { contains: value } };
            } else if (["feed", "f"].includes(key)) {
                condition = {
                    feed: {
                        OR: [
                            { id: value },
                            { name: { contains: value } },
                            { url: { contains: value } },
                        ],
                    },
                };
            } else if (["category", "cat", "c"].includes(key)) {
                condition = {
                    feed: {
                        category: {
                            OR: [
                                { id: value },
                                { name: { contains: value } },
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
                                    { name: { contains: value } },
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

    for (const term of freeText) {
        and.push({
            OR: [
                { title: { contains: term } },
                { content: { contains: term } },
                { excerpt: { contains: term } },
                { author: { contains: term } },
                { link: { contains: term } },
                { feed: { name: { contains: term } } },
                { labels: { some: { label: { name: { contains: term }, userId } } } },
            ],
        });
    }

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
    const results = nonEmptyGroups
        .map(g => processGroupTokens(userId, g))
        .filter(r => Object.keys(r).length > 0);

    if (results.length === 0) return {};
    if (results.length === 1) return results[0];
    return { OR: results };
}
