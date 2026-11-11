import type { ResolvedFeed } from "./smart-url-resolver";

/**
 * Curated publisher → native feed rules.
 *
 * Scope rules (a publisher match short-circuits normal discovery, so it must
 * never broaden what the user asked for):
 * - Only exact, listed hosts match (after stripping `www.`/`m.`/`mobile.`).
 *   Unlisted subdomains (`sport.example`, `feeds.example`, …) are no match.
 * - A URL that is itself a feed (feed-looking path or a known feed host) is
 *   never rewritten — normal discovery validates it as a direct feed.
 * - The homepage maps to the publisher's main feed; a section URL maps only
 *   to that section's verified feed. Any other path is no match, so normal
 *   discovery (`<link rel=alternate>`, common paths) continues.
 *
 * Every feed URL below was verified live (HTTP 200, parses as RSS/Atom with
 * items) on 2026-11-11; see PR #254.
 */

export type PublisherRoute = {
  feedUrl: string;
  title: string;
  format?: "rss" | "atom";
};

type SectionRule = {
  /** Leading path segments that identify the section (lower-case). */
  path: string[];
  route: PublisherRoute;
  /** Match only this exact path (not article pages below it). */
  exact?: boolean;
};

type PublisherDef = {
  platform: string;
  /** Exact hosts, without `www.`. */
  hosts: string[];
  /** Feed for the bare homepage (path `/`). */
  home?: PublisherRoute;
  sections?: SectionRule[];
};

function sections(
  base: string[],
  entries: Array<[segment: string, feedUrl: string, title: string]>,
  format: "rss" | "atom",
): SectionRule[] {
  return entries.map(([segment, feedUrl, title]) => ({
    path: [...base, segment],
    route: { feedUrl, title, format },
  }));
}

const PUBLISHERS: PublisherDef[] = [
  {
    platform: "tagesschau",
    hosts: ["tagesschau.de"],
    home: { feedUrl: "https://www.tagesschau.de/infoservices/alle-meldungen-100~rss2.xml", title: "Tagesschau · Alle Meldungen", format: "rss" },
    sections: sections([], [
      ["inland", "https://www.tagesschau.de/inland/index~rss2.xml", "Tagesschau · Inland"],
      ["ausland", "https://www.tagesschau.de/ausland/index~rss2.xml", "Tagesschau · Ausland"],
      ["wirtschaft", "https://www.tagesschau.de/wirtschaft/index~rss2.xml", "Tagesschau · Wirtschaft"],
      ["investigativ", "https://www.tagesschau.de/investigativ/index~rss2.xml", "Tagesschau · Investigativ"],
      ["wissen", "https://www.tagesschau.de/wissen/index~rss2.xml", "Tagesschau · Wissen"],
      ["faktenfinder", "https://www.tagesschau.de/faktenfinder/index~rss2.xml", "Tagesschau · Faktenfinder"],
    ], "rss"),
  },
  {
    platform: "heise",
    hosts: ["heise.de"],
    home: { feedUrl: "https://www.heise.de/rss/heise-atom.xml", title: "Heise · News", format: "atom" },
    sections: sections([], [
      ["ct", "https://www.heise.de/ct/feed.xml", "Heise · c't"],
      ["developer", "https://www.heise.de/developer/feed.xml", "Heise · Developer"],
      ["security", "https://www.heise.de/security/feed.xml", "Heise · Security"],
      ["ix", "https://www.heise.de/ix/feed.xml", "Heise · iX"],
      ["make", "https://www.heise.de/make/feed.xml", "Heise · Make"],
      ["autos", "https://www.heise.de/autos/feed.xml", "Heise · Autos"],
    ], "atom"),
  },
  {
    platform: "heise",
    hosts: ["ct.de"],
    home: { feedUrl: "https://www.heise.de/ct/feed.xml", title: "Heise · c't", format: "atom" },
  },
  {
    platform: "heise",
    hosts: ["telepolis.de"],
    home: { feedUrl: "https://www.telepolis.de/feed.xml", title: "Telepolis", format: "atom" },
  },
  {
    platform: "spiegel",
    hosts: ["spiegel.de"],
    home: { feedUrl: "https://www.spiegel.de/schlagzeilen/index.rss", title: "Spiegel · Schlagzeilen", format: "rss" },
    sections: sections([], [
      ["politik", "https://www.spiegel.de/politik/index.rss", "Spiegel · Politik"],
      ["wirtschaft", "https://www.spiegel.de/wirtschaft/index.rss", "Spiegel · Wirtschaft"],
      ["panorama", "https://www.spiegel.de/panorama/index.rss", "Spiegel · Panorama"],
      ["kultur", "https://www.spiegel.de/kultur/index.rss", "Spiegel · Kultur"],
      ["wissenschaft", "https://www.spiegel.de/wissenschaft/index.rss", "Spiegel · Wissenschaft"],
      ["netzwelt", "https://www.spiegel.de/netzwelt/index.rss", "Spiegel · Netzwelt"],
      ["sport", "https://www.spiegel.de/sport/index.rss", "Spiegel · Sport"],
      ["ausland", "https://www.spiegel.de/ausland/index.rss", "Spiegel · Ausland"],
      ["geschichte", "https://www.spiegel.de/geschichte/index.rss", "Spiegel · Geschichte"],
    ], "rss"),
  },
  {
    platform: "bbc",
    hosts: ["bbc.com", "bbc.co.uk"],
    // No `home`: the BBC homepage spans sport, weather, iPlayer… — not just news.
    sections: [
      { path: ["news"], exact: true, route: { feedUrl: "https://feeds.bbci.co.uk/news/rss.xml", title: "BBC News · Top Stories", format: "rss" } },
      ...sections(["news"], [
        ["world", "https://feeds.bbci.co.uk/news/world/rss.xml", "BBC News · World"],
        ["uk", "https://feeds.bbci.co.uk/news/uk/rss.xml", "BBC News · UK"],
        ["business", "https://feeds.bbci.co.uk/news/business/rss.xml", "BBC News · Business"],
        ["politics", "https://feeds.bbci.co.uk/news/politics/rss.xml", "BBC News · Politics"],
        ["health", "https://feeds.bbci.co.uk/news/health/rss.xml", "BBC News · Health"],
        ["education", "https://feeds.bbci.co.uk/news/education/rss.xml", "BBC News · Education"],
        ["science_and_environment", "https://feeds.bbci.co.uk/news/science_and_environment/rss.xml", "BBC News · Science & Environment"],
        ["technology", "https://feeds.bbci.co.uk/news/technology/rss.xml", "BBC News · Technology"],
        ["entertainment_and_arts", "https://feeds.bbci.co.uk/news/entertainment_and_arts/rss.xml", "BBC News · Entertainment & Arts"],
      ], "rss"),
    ],
  },
  {
    platform: "npr",
    hosts: ["npr.org"],
    home: { feedUrl: "https://feeds.npr.org/1001/rss.xml", title: "NPR · News", format: "rss" },
    sections: sections(["sections"], [
      ["news", "https://feeds.npr.org/1001/rss.xml", "NPR · News"],
      ["national", "https://feeds.npr.org/1003/rss.xml", "NPR · National"],
      ["world", "https://feeds.npr.org/1004/rss.xml", "NPR · World"],
      ["politics", "https://feeds.npr.org/1014/rss.xml", "NPR · Politics"],
      ["business", "https://feeds.npr.org/1006/rss.xml", "NPR · Business"],
      ["science", "https://feeds.npr.org/1007/rss.xml", "NPR · Science"],
      ["health", "https://feeds.npr.org/1128/rss.xml", "NPR · Health"],
      ["technology", "https://feeds.npr.org/1019/rss.xml", "NPR · Technology"],
    ], "rss"),
  },
  {
    platform: "nytimes",
    hosts: ["nytimes.com"],
    home: { feedUrl: "https://rss.nytimes.com/services/xml/rss/nyt/HomePage.xml", title: "The New York Times · Home Page", format: "rss" },
    sections: sections(["section"], [
      ["world", "https://rss.nytimes.com/services/xml/rss/nyt/World.xml", "The New York Times · World"],
      ["us", "https://rss.nytimes.com/services/xml/rss/nyt/US.xml", "The New York Times · U.S."],
      ["business", "https://rss.nytimes.com/services/xml/rss/nyt/Business.xml", "The New York Times · Business"],
      ["technology", "https://rss.nytimes.com/services/xml/rss/nyt/Technology.xml", "The New York Times · Technology"],
      ["science", "https://rss.nytimes.com/services/xml/rss/nyt/Science.xml", "The New York Times · Science"],
      ["health", "https://rss.nytimes.com/services/xml/rss/nyt/Health.xml", "The New York Times · Health"],
      ["arts", "https://rss.nytimes.com/services/xml/rss/nyt/Arts.xml", "The New York Times · Arts"],
      ["books", "https://rss.nytimes.com/services/xml/rss/nyt/Books.xml", "The New York Times · Books"],
      ["opinion", "https://rss.nytimes.com/services/xml/rss/nyt/Opinion.xml", "The New York Times · Opinion"],
    ], "rss"),
  },
  {
    platform: "zeit",
    hosts: ["zeit.de"],
    home: { feedUrl: "https://newsfeed.zeit.de/index", title: "ZEIT ONLINE · Startseite", format: "rss" },
    sections: sections([], [
      ["politik", "https://newsfeed.zeit.de/politik/index", "ZEIT ONLINE · Politik"],
      ["wirtschaft", "https://newsfeed.zeit.de/wirtschaft/index", "ZEIT ONLINE · Wirtschaft"],
      ["digital", "https://newsfeed.zeit.de/digital/index", "ZEIT ONLINE · Digital"],
      ["gesellschaft", "https://newsfeed.zeit.de/gesellschaft/index", "ZEIT ONLINE · Gesellschaft"],
      ["mobilitaet", "https://newsfeed.zeit.de/mobilitaet/index", "ZEIT ONLINE · Mobilität"],
    ], "rss"),
  },
  {
    platform: "sueddeutsche",
    hosts: ["sueddeutsche.de"],
    home: { feedUrl: "https://rss.sueddeutsche.de/rss/Alles", title: "Süddeutsche Zeitung · Alle Meldungen", format: "rss" },
    sections: sections([], [
      ["politik", "https://rss.sueddeutsche.de/rss/Politik", "Süddeutsche Zeitung · Politik"],
      ["wirtschaft", "https://rss.sueddeutsche.de/rss/Wirtschaft", "Süddeutsche Zeitung · Wirtschaft"],
      ["kultur", "https://rss.sueddeutsche.de/rss/Kultur", "Süddeutsche Zeitung · Kultur"],
      ["wissen", "https://rss.sueddeutsche.de/rss/Wissen", "Süddeutsche Zeitung · Wissen"],
      ["panorama", "https://rss.sueddeutsche.de/rss/Panorama", "Süddeutsche Zeitung · Panorama"],
      ["sport", "https://rss.sueddeutsche.de/rss/Sport", "Süddeutsche Zeitung · Sport"],
      ["digital", "https://rss.sueddeutsche.de/rss/Digital", "Süddeutsche Zeitung · Digital"],
    ], "rss"),
  },
  {
    platform: "faz",
    hosts: ["faz.net"],
    home: { feedUrl: "https://www.faz.net/rss/aktuell/", title: "FAZ · Aktuell", format: "rss" },
    sections: [
      { path: ["aktuell"], exact: true, route: { feedUrl: "https://www.faz.net/rss/aktuell/", title: "FAZ · Aktuell", format: "rss" } },
      ...sections(["aktuell"], [
        ["politik", "https://www.faz.net/rss/aktuell/politik/", "FAZ · Politik"],
        ["wirtschaft", "https://www.faz.net/rss/aktuell/wirtschaft/", "FAZ · Wirtschaft"],
        ["finanzen", "https://www.faz.net/rss/aktuell/finanzen/", "FAZ · Finanzen"],
        ["feuilleton", "https://www.faz.net/rss/aktuell/feuilleton/", "FAZ · Feuilleton"],
        ["sport", "https://www.faz.net/rss/aktuell/sport/", "FAZ · Sport"],
        ["gesellschaft", "https://www.faz.net/rss/aktuell/gesellschaft/", "FAZ · Gesellschaft"],
        ["technik-motor", "https://www.faz.net/rss/aktuell/technik-motor/", "FAZ · Technik & Motor"],
        ["wissen", "https://www.faz.net/rss/aktuell/wissen/", "FAZ · Wissen"],
      ], "rss"),
    ],
  },
  {
    platform: "golem",
    hosts: ["golem.de"],
    home: { feedUrl: "https://rss.golem.de/rss.php?feed=ATOM1.0", title: "Golem.de · Alle News", format: "atom" },
    sections: sections(["specials"], [
      ["security", "https://rss.golem.de/rss.php?tp=sec&feed=ATOM1.0", "Golem.de · Security"],
      ["open-source", "https://rss.golem.de/rss.php?tp=oss&feed=ATOM1.0", "Golem.de · Open Source"],
      ["games", "https://rss.golem.de/rss.php?tp=games&feed=ATOM1.0", "Golem.de · Games"],
    ], "atom"),
  },
  {
    platform: "t3n",
    hosts: ["t3n.de"],
    home: { feedUrl: "https://t3n.de/rss.xml", title: "t3n · News", format: "rss" },
  },
  {
    platform: "netzpolitik",
    hosts: ["netzpolitik.org"],
    home: { feedUrl: "https://netzpolitik.org/feed/", title: "netzpolitik.org · Aktuell", format: "rss" },
  },
  {
    platform: "derstandard",
    hosts: ["derstandard.at"],
    home: { feedUrl: "https://www.derstandard.at/rss", title: "Der Standard · Alle Meldungen", format: "rss" },
    sections: sections([], [
      ["international", "https://www.derstandard.at/rss/international", "Der Standard · International"],
      ["inland", "https://www.derstandard.at/rss/inland", "Der Standard · Inland"],
      ["wirtschaft", "https://www.derstandard.at/rss/wirtschaft", "Der Standard · Wirtschaft"],
      ["web", "https://www.derstandard.at/rss/web", "Der Standard · Web"],
      ["sport", "https://www.derstandard.at/rss/sport", "Der Standard · Sport"],
      ["panorama", "https://www.derstandard.at/rss/panorama", "Der Standard · Panorama"],
      ["kultur", "https://www.derstandard.at/rss/kultur", "Der Standard · Kultur"],
      ["wissenschaft", "https://www.derstandard.at/rss/wissenschaft", "Der Standard · Wissenschaft"],
    ], "rss"),
  },
];

/** A URL that already points at a feed: never rewrite it. */
function looksLikeFeedUrl(path: string, search: string): boolean {
  if (/\.(?:xml|rss|rdf|atom|json)$/i.test(path)) return true;
  if (/~rss\d*\.xml|rss\.php/i.test(path)) return true;
  if (path.split("/").some((seg) => /^(?:rss|feed|feeds|atom|index\.rss)$/i.test(seg))) return true;
  return /[?&](?:feed|format)=(?:rss|atom)/i.test(search);
}

const ALIAS_PREFIX = /^(?:www|m|mobile)\./;

export function resolvePublisherFeeds(url: URL): ResolvedFeed[] {
  if (url.protocol !== "https:" && url.protocol !== "http:") return [];
  const host = url.hostname.toLowerCase().replace(/\.$/, "").replace(ALIAS_PREFIX, "");
  const pub = PUBLISHERS.find((p) => p.hosts.includes(host));
  if (!pub) return [];

  const path = url.pathname.replace(/\/{2,}/g, "/");
  if (looksLikeFeedUrl(path, url.search)) return [];

  const segs = path.split("/").filter(Boolean).map((s) => s.toLowerCase());
  let route: PublisherRoute | null = null;
  if (segs.length === 0) {
    route = pub.home ?? null;
  } else {
    let bestLen = 0;
    for (const rule of pub.sections ?? []) {
      if (rule.path.length > segs.length || rule.path.length <= bestLen) continue;
      if (rule.exact && rule.path.length !== segs.length) continue;
      if (rule.path.every((seg, i) => segs[i] === seg)) {
        route = rule.route;
        bestLen = rule.path.length;
      }
    }
  }
  if (!route) return [];

  return [
    {
      url: route.feedUrl,
      title: route.title,
      kind: "news",
      platform: pub.platform,
      confidence: 0.95,
      format: route.format ?? "rss",
      verify: true,
    },
  ];
}

/** Every curated feed URL (used by the live verification script/tests). */
export function allPublisherFeedUrls(): string[] {
  const urls = new Set<string>();
  for (const pub of PUBLISHERS) {
    if (pub.home) urls.add(pub.home.feedUrl);
    for (const rule of pub.sections ?? []) urls.add(rule.route.feedUrl);
  }
  return [...urls];
}
