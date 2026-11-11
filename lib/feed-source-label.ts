// Where a discovered feed came from, as an i18n key under `sidebar.feedSource`
// ("Reddit-Feed", "Discourse-Forum", "über RSSHub", "Von der Seite angeboten").
// Client-safe (no server imports).

export type FeedSourceFields = {
  source?: string;
  via?: { family: string; name: string };
};

const FAMILY_KEYS = new Set(["platform", "forum", "blog", "wiki", "rsshub"]);

export function feedSourceLabel(feed: FeedSourceFields): { key: string; values: { name: string } } | null {
  if (feed.via && FAMILY_KEYS.has(feed.via.family)) {
    return { key: `feedSource.${feed.via.family}`, values: { name: feed.via.name } };
  }
  switch (feed.source) {
    case "radar":
      return { key: "feedSource.rsshub", values: { name: "RSSHub" } };
    case "html":
      return { key: "feedSource.html", values: { name: "" } };
    case "common-path":
      return { key: "feedSource.commonPath", values: { name: "" } };
    case "curated":
      return { key: "feedSource.curated", values: { name: "" } };
    default:
      return null;
  }
}
