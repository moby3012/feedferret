import { createHash } from "crypto";
// Stable per-feed article identity shared by the sync pipeline and the importers
// (FreshRSS article JSON), so an imported article and the same article arriving
// through a later sync resolve to the same `(userId, feedId, dedupeKey)` row.

export interface DedupeKeyItem {
    link?: string | null;
    title?: string | null;
    author?: string | null;
    publishedAt?: Date | null;
    /** Only read by FreshRSS' content-based `sha1:*` criteria. */
    content?: string | null;
}

// FreshRSS hashed criteria (`frss:unicityCriteria`, app/Models/Feed.php
// decideEntryGuid): sha1 over the concatenated link, Unix publish time, title and
// content, in exactly this order. Computed the same way so a FreshRSS-migrated feed
// keeps the identity FreshRSS gave its articles.
const FRESHRSS_SHA1_CRITERIA: Record<string, ReadonlyArray<"link" | "published" | "title" | "content">> = {
    "sha1:link_published": ["link", "published"],
    "sha1:link_published_title": ["link", "published", "title"],
    "sha1:link_published_title_content": ["link", "published", "title", "content"],
    "sha1:title": ["title"],
    "sha1:title_published": ["title", "published"],
    "sha1:title_published_content": ["title", "published", "content"],
    "sha1:content": ["content"],
    "sha1:content_published": ["content", "published"],
    "sha1:published": ["published"],
};

export function isFreshRssHashedCriteria(criteria: string | null | undefined): boolean {
    return Boolean(criteria && Object.prototype.hasOwnProperty.call(FRESHRSS_SHA1_CRITERIA, criteria));
}

function freshRssHashedKey(criteria: string, item: DedupeKeyItem): string | null {
    const fields = FRESHRSS_SHA1_CRITERIA[criteria];
    const input = fields
        .map((field) => {
            if (field === "published") return item.publishedAt ? String(Math.floor(item.publishedAt.getTime() / 1000)) : "";
            return item[field] ?? "";
        })
        .join("");
    // FreshRSS treats sha1('') as "no GUID" and falls back to the item id.
    return input ? `sha1:${createHash("sha1").update(input).digest("hex")}` : null;
}

export function buildDedupeKey(
    feed: { unicityCriteria?: string | null },
    item: DedupeKeyItem,
    externalId: string | null,
): string {
    if (isFreshRssHashedCriteria(feed.unicityCriteria)) {
        return freshRssHashedKey(feed.unicityCriteria!, item) ?? (externalId || item.link || item.title || "");
    }
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
