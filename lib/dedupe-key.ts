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
    /**
     * The item's own guid/id as published by the feed (no link fallback). Only read by
     * the `sha1:*` criteria; when absent, the `externalId` argument is used instead.
     */
    guid?: string | null;
}

// FreshRSS hashed criteria (`frss:unicityCriteria`), ported from FreshRSS
// app/Models/Feed.php `decideEntryGuid($item, fallback: true)` as used by
// `loadGuids`/`loadEntries`: the GUID is the bare lowercase SHA-1 hex of the
// concatenated permalink, Unix publish time (`get_date('U')`, "" when absent),
// title and content, in exactly the listed order. Computed identically so a
// feed moved from FreshRSS keeps the identity FreshRSS gave its articles.
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

const sha1Hex = (value: string) => createHash("sha1").update(value).digest("hex");
/** FreshRSS treats sha1('') as "no GUID". */
const BLANK_SHA1 = sha1Hex("");

export function isFreshRssHashedCriteria(criteria: string | null | undefined): boolean {
    return Boolean(criteria && Object.prototype.hasOwnProperty.call(FRESHRSS_SHA1_CRITERIA, criteria));
}

function freshRssFields(item: DedupeKeyItem) {
    return {
        link: item.link ?? "",
        published: item.publishedAt ? String(Math.floor(item.publishedAt.getTime() / 1000)) : "",
        title: item.title ?? "",
        content: item.content ?? "",
    };
}

/**
 * FreshRSS `decideEntryGuid(fallback: true)` for a `sha1:*` criterion. `entryId` is
 * SimplePie's `get_id(false, false)`: the item's own guid/id, or "" when it has none
 * (`$fn === false` returns null, no permalink/title fallback).
 */
export function freshRssHashedGuid(criteria: string, item: DedupeKeyItem, externalId: string | null): string {
    const f = freshRssFields(item);
    let guid = sha1Hex(FRESHRSS_SHA1_CRITERIA[criteria].map((field) => f[field]).join(""));
    if (guid === BLANK_SHA1) guid = "";
    if (guid !== "") return guid;

    const entryId = (item.guid !== undefined ? item.guid : externalId) ?? "";
    if (entryId !== "") guid = entryId;
    else if (f.link !== "") guid = sha1Hex(f.link + f.published);
    else if (f.title !== "") guid = sha1Hex(f.link + f.published + f.title);
    else guid = sha1Hex(f.link + f.published + f.title + f.content);
    return guid === BLANK_SHA1 ? "" : guid;
}

export function buildDedupeKey(
    feed: { unicityCriteria?: string | null },
    item: DedupeKeyItem,
    externalId: string | null,
): string {
    if (isFreshRssHashedCriteria(feed.unicityCriteria)) return freshRssHashedGuid(feed.unicityCriteria!, item, externalId);
    return genericDedupeKey(feed.unicityCriteria, item, externalId);
}

/** FeedFerret's own `part:part` criteria; also what every version before #280 did for `sha1:*`. */
function genericDedupeKey(criteria: string | null | undefined, item: DedupeKeyItem, externalId: string | null): string {
    const parts = (criteria || "id")
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

/**
 * Keys an article of a `sha1:*` feed may already be stored under. Versions before #280
 * did not know these criteria and ran them through the generic `part:part` algorithm
 * (`sha1:title` → the bare title, `sha1:link_published` → guid/link/title); pre-release
 * builds of #280 stored a `sha1:`-prefixed digest. `legacyItem` is the item as those
 * versions saw it (identity title "Untitled" for title-less items, content as fetched).
 * The sync re-keys a row found under one of these in place. Empty for other criteria.
 */
export function legacyDedupeKeys(
    feed: { unicityCriteria?: string | null },
    item: DedupeKeyItem,
    externalId: string | null,
    legacyItem: DedupeKeyItem = item,
): string[] {
    if (!isFreshRssHashedCriteria(feed.unicityCriteria)) return [];
    const current = buildDedupeKey(feed, item, externalId);
    const f = freshRssFields(legacyItem);
    const input = FRESHRSS_SHA1_CRITERIA[feed.unicityCriteria!].map((field) => f[field]).join("");
    const candidates = [genericDedupeKey(feed.unicityCriteria, legacyItem, externalId), input ? `sha1:${sha1Hex(input)}` : ""];
    return [...new Set(candidates.filter((key) => key && key !== current))];
}
