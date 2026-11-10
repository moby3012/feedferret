// Stable per-feed article identity shared by the sync pipeline and the importers
// (FreshRSS article JSON), so an imported article and the same article arriving
// through a later sync resolve to the same `(userId, feedId, dedupeKey)` row.

export interface DedupeKeyItem {
    link?: string | null;
    title?: string | null;
    author?: string | null;
    publishedAt?: Date | null;
}

export function buildDedupeKey(
    feed: { unicityCriteria?: string | null },
    item: DedupeKeyItem,
    externalId: string | null,
): string {
    const parts = (feed.unicityCriteria || "id")
        .split(":")
        .map((part) => part.trim())
        .filter(Boolean);

    const valueFor = (part: string) => {
        if (part === "id" || part === "guid" || part === "uid") return externalId;
        if (part === "link" || part === "uri" || part === "url") return item.link;
        if (part === "title") return item.title;
        if (part === "author") return item.author;
        if (part === "date" || part === "timestamp") return item.publishedAt?.toISOString();
        return null;
    };

    const values = parts.map(valueFor).filter(Boolean);
    if (values.length > 0) return values.join(":");
    return externalId || item.link || item.title || "";
}
