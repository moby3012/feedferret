// N1: shared constants, kept dependency-free so the sync path does not pull
// postal-mime/jsdom-heavy lib/inbound-email.ts into its import graph.
export const NEWSLETTER_SOURCE_TYPE = "newsletter";
export const NEWSLETTER_CATEGORY_NAME = "Newsletter";
export const NEWSLETTER_FEED_URL_PREFIX = "newsletter:";

/** Newsletter feeds have no fetchable URL ("newsletter:<sender>"): no refresh / health / website actions. */
export function isNewsletterFeed(feed: { sourceType?: string | null; url?: string | null } | null | undefined): boolean {
  if (!feed) return false;
  return feed.sourceType === NEWSLETTER_SOURCE_TYPE || (typeof feed.url === "string" && feed.url.startsWith(NEWSLETTER_FEED_URL_PREFIX));
}

/** An http(s) article link (newsletters without a web version link to "newsletter:…#…"). */
export function isWebLink(link: string | null | undefined): boolean {
  return typeof link === "string" && /^https?:\/\//i.test(link);
}
