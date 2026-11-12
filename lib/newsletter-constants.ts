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

// ---------------------------------------------------------------------------
// Inbound sources (InboundMailSource.kind)

/** Active ways in: IMAP poller, Cloudflare Email Worker, generic webhook (Postmark / Mailgun / …). */
export const INBOUND_KINDS = ["imap", "cloudflare", "webhook"] as const;
export type InboundKind = (typeof INBOUND_KINDS)[number];
/** Kinds delivered by an HTTPS push (`/api/webhooks/inbound-email/<id>`); their address is a routed domain. */
export const WEBHOOK_KINDS = ["cloudflare", "webhook"] as const;
export type WebhookKind = (typeof WEBHOOK_KINDS)[number];
/**
 * A disconnected source keeps only its base address (credentials and secret
 * are wiped) so reconnecting the same one keeps every user address.
 */
export const DISCONNECTED_KINDS = INBOUND_KINDS.map((kind) => `${kind}-disconnected`);

export function isWebhookKind(kind: string | null | undefined): kind is WebhookKind {
  return kind === "cloudflare" || kind === "webhook";
}

/** User addresses look alike within a family: `box+ff-<token>@host` (imap) vs `<token>@domain`. */
function addressFamily(kind: string): "imap" | "domain" {
  return kind.startsWith("imap") ? "imap" : "domain";
}

/** Would going from `previous` to `next` change the addresses already handed out? */
export function sourceAddressesChange(previous: { kind: string; address: string | null } | null, next: { kind: string; address: string }): boolean {
  if (!previous) return false;
  return addressFamily(previous.kind) !== addressFamily(next.kind) || (previous.address ?? "").toLowerCase() !== next.address.toLowerCase();
}

/** Where a webhook source receives mail (relative; the browser knows the public origin). */
export function webhookPathFor(sourceId: string): string {
  return `/api/webhooks/inbound-email/${sourceId}`;
}
