// N1: shared constants, kept dependency-free so the sync path does not pull
// postal-mime/jsdom-heavy lib/inbound-email.ts into its import graph.
export const NEWSLETTER_SOURCE_TYPE = "newsletter";
export const NEWSLETTER_CATEGORY_NAME = "Newsletter";
export const NEWSLETTER_FEED_URL_PREFIX = "newsletter:";
