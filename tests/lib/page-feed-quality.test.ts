import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { HARD_BUDGET_FACTOR, SUGGEST_TIME_BUDGET_MS, suggestFeedCandidatesDetailed, type FeedCandidate } from "../../lib/page-feed-suggest-core";
import {
  assessPreviewQuality,
  classifyItem,
  isArticleLikeLink,
  isPlaceholderTitle,
  linkKey,
  siteLabel,
} from "../../lib/page-feed-quality";
import type { FetchedFeedArticle } from "../../lib/feed-fetcher";

// Offline fixtures: trimmed copies of the live pages from the T1 benchmark
// (scripts/bench/feed-everything.sites.json), captured 2026-11-11 with
// scripts/bench/capture-page-fixtures.mts. No network in these tests.
const FIXTURES = path.resolve(__dirname, "../fixtures/page-feed");
const SITES: Array<{ id: string; url: string }> = JSON.parse(
  readFileSync(path.resolve(__dirname, "../../scripts/bench/feed-everything.sites.json"), "utf8"),
);

// Fixture results must not depend on how fast the machine is: no time budget here. The budget itself
// (soft until a first candidate exists, hard cap, best-so-far) is tested below with an injected clock.
const UNLIMITED = { timeBudgetMs: Infinity };

function suggest(id: string) {
  const site = SITES.find((s) => s.id === id);
  if (!site) throw new Error(`unknown bench site ${id}`);
  const html = readFileSync(path.join(FIXTURES, `${id}.html`), "utf8");
  return { url: site.url, ...suggestFeedCandidatesDetailed(html, site.url, UNLIMITED) };
}

const top = (candidates: FeedCandidate[]) => candidates[0];
const links = (c: FeedCandidate) => c.previewArticles.map((a) => a.link);
const titles = (c: FeedCandidate) => c.previewArticles.map((a) => a.title);

// Large real homepages: one JSDOM parse each, but a few take seconds.
const SLOW = 60_000;

describe("selector quality gate — bad cases from the T1 benchmark", () => {
  // Pages whose only repeating lists are navigation/login/maps/placeholders:
  // no selector may be offered at all.
  const REJECTED: Array<[id: string, why: string]> = [
    ["company-8", "Apple Careers: Work at Apple / Life at Apple navigation"],
    ["forums-2", "discuss.python.org: forum category links (/c/<slug>/<id>)"],
    ["government-1", "Bundesregierung: footer social-media links"],
    ["government-6", "ECB press page: monetary-policy site navigation"],
    ["js-heavy-1", "Notion: product/use-case CTA cards"],
    ["no-feed-3", "Wikipedia portal: sister-project links"],
    ["social-8", "X profile without posts: empty titles/links"],
    ["social-11", "LinkedIn company: Bing Maps office locations + job hubs"],
    ["social-12", "Threads profile: login/navigation links"],
  ];
  it.each(REJECTED)("%s is not offered (%s)", (id) => {
    const result = suggest(id);
    expect(result.candidates).toEqual([]);
  }, SLOW);

  it("Stripe blog: picks post links, not /blog/product category kickers", () => {
    const { candidates } = suggest("company-2");
    const best = top(candidates);
    expect(best).toBeDefined();
    expect(links(best).some((l) => /\/blog\/(product|industry|engineering)$/.test(l))).toBe(false);
    expect(links(best).every((l) => l.startsWith("https://stripe.com/blog/"))).toBe(true);
    expect(new Set(links(best)).size).toBeGreaterThanOrEqual(5);
  }, SLOW);

  it("Lever job board: vacancy names, never the 'Apply' button text", () => {
    const { candidates } = suggest("jobs-3");
    const best = top(candidates);
    expect(titles(best)).not.toContain("Apply");
    // The per-posting list wins over the per-team grouping block.
    expect(best.itemCount).toBeGreaterThan(50);
  }, SLOW);

  it("Greenhouse: repeated vacancy is offered only with a duplicates review label", () => {
    const best = top(suggest("jobs-4").candidates);
    expect(best.quality.verdict).toBe("review");
    expect(best.quality.reasons).toContain("duplicates");
  }, SLOW);

  it("Spiegel: image-only twin cards are filtered out of the selector (no Untitled items)", () => {
    const best = top(suggest("news-de-2").candidates);
    expect(titles(best)).not.toContain("Untitled");
    expect(best.config.xPathItem).toContain("normalize-space(");
  }, SLOW);

  it("heise: the DoubleClick ad card is excluded by the saved selector", () => {
    const best = top(suggest("news-de-3").candidates);
    expect(links(best).some((l) => l.includes("doubleclick"))).toBe(false);
    expect(best.config.xPathItem).toContain("doubleclick");
    expect(best.quality.verdict).toBe("ok");
  }, SLOW);

  it("tagesschau: the TV/broadcast strip items are marked in the preview", () => {
    const best = top(suggest("news-de-1").candidates);
    // 3–5 programme links among ~28 news items: flagged per item, not enough
    // to label the whole list.
    expect(best.previewIssues.filter(Boolean).length).toBeGreaterThanOrEqual(2);
    expect(best.quality.plausibleItems).toBeGreaterThanOrEqual(20);
  }, SLOW);

  it("NPR: links point at stories, not the /sections/ kicker; no untitled cards", () => {
    const best = top(suggest("news-intl-5").candidates);
    expect(links(best).some((l) => /\/sections\/[^/]+\/?$/.test(l))).toBe(false);
    expect(titles(best)).not.toContain("Untitled");
  }, SLOW);

  it("Apple Podcasts: the episode list wins over the show/genre shelf", () => {
    const best = top(suggest("podcasts-3").candidates);
    expect(titles(best)).not.toContain("Untitled");
    for (const genre of ["Sports", "Science", "Society & Culture"]) expect(titles(best)).not.toContain(genre);
    expect(links(best).every((l) => l.startsWith("https://podcasts.apple.com/us/podcast/"))).toBe(true);
  }, SLOW);
});

describe("selector quality gate — good cases keep working", () => {
  const GOOD: Array<[id: string, minPlausible: number, linkPrefix: RegExp]> = [
    ["news-de-6", 20, /^https:\/\/www\.faz\.net\//],
    ["news-de-7", 8, /^https:\/\/www\.deutschlandfunk(kultur)?\.de\//],
    ["news-intl-2", 10, /^https:\/\/www\.bbc\.com\/news\//],
    ["news-intl-8", 10, /^https:\/\/www\.lemonde\.fr\//],
    ["company-5", 15, /^https:\/\/www\.anthropic\.com\//],
    ["government-3", 4, /^https:\/\/(www\.rki\.de|gesund\.bund\.de)\//],
    ["events-2", 20, /^https:\/\/www\.berlin\.de\/tickets\//],
    ["events-3", 10, /^https:\/\/www\.eventbrite\.(com|de)\/e\//],
    ["events-4", 5, /^https:\/\/www\.meetup\.com\/[^/]+\/events\/\d+/],
    ["shops-6", 15, /^https:\/\/books\.toscrape\.com\/catalogue\//],
    ["no-feed-4", 10, /^https:\/\/www\.berlin\.de\/aktuelles\//],
  ];
  it.each(GOOD)("%s offers an entry list", (id, minPlausible, linkPrefix) => {
    const best = top(suggest(id).candidates);
    expect(best).toBeDefined();
    expect(best.quality.plausibleItems).toBeGreaterThanOrEqual(minPlausible);
    // The preview is mostly real entries on the expected site.
    const onSite = links(best).filter((l) => linkPrefix.test(l)).length;
    expect(onSite / best.previewArticles.length).toBeGreaterThanOrEqual(0.6);
    expect(titles(best).filter((t) => isPlaceholderTitle(t)).length).toBe(0);
    expect(best.previewIssues.filter(Boolean).length).toBeLessThanOrEqual(2);
  }, SLOW);

  it("anthropic.com/news (dated, on-section) passes without a review label", () => {
    const best = top(suggest("company-5").candidates);
    expect(best.quality.verdict).toBe("ok");
  }, SLOW);

  it("undated listings are offered without a review label; missing dates is a note", () => {
    for (const id of ["shops-6", "news-de-6", "events-2", "no-feed-4"]) {
      const best = top(suggest(id).candidates);
      expect(best.quality.verdict, id).toBe("ok");
      expect(best.quality.notes, id).toEqual(["missingDates"]);
    }
  }, SLOW);
});

describe("item classification", () => {
  const page = new URL("https://example.com/blog");
  const item = (title: string, link: string) => ({ title, link });

  it.each([
    ["ad", item("Sponsored story", "https://pubads.g.doubleclick.net/gampad/clk?id=1")],
    ["map", item("Office Redmond", "https://www.bing.com/maps?where=Redmond")],
    ["map", item("HQ", "https://maps.google.com/?q=Berlin")],
    ["login", item("Log in to see more", "https://example.com/login?next=/blog")],
    ["login", item("Join the conversation today", "https://accounts.example.com/signup")],
    ["social", item("Follow us on Instagram", "https://www.instagram.com/example/")],
    ["placeholderTitle", item("Apply", "https://example.com/jobs/1234")],
    ["placeholderTitle", item("Read more →", "https://example.com/blog/a-long-post-slug")],
    ["placeholderTitle", item("Weiterlesen", "https://example.com/blog/ein-langer-artikel")],
    ["placeholderTitle", item("Untitled", "https://example.com/blog/a-long-post-slug")],
    ["placeholderTitle", item("Home", "https://example.com/")],
    ["navigation", item("Back to the start page", "https://example.com/")],
    ["navigation", item("Python Help discussions", "https://example.com/c/help/7")],
    ["navigation", item("All posts in the blog", "https://example.com/blog")],
    ["noLink", item("A real looking title", "")],
  ])("%s ← %j", (issue, it) => {
    expect(classifyItem(it, page)).toBe(issue);
  });

  it("a short slug alone is an entry; the same hub link repeated across cards is not", () => {
    const kicker = item("Product updates", "https://example.com/blog/product");
    expect(classifyItem(kicker, page)).toBeNull();
    expect(classifyItem(item("Regex", "https://example.com/blog/regex"), page)).toBeNull();
    expect(classifyItem(item("The gap", "https://example.com/essays/the-gap"), page)).toBeNull();
    expect(classifyItem(kicker, page, { repeatedHubs: new Set([linkKey(kicker.link)]) })).toBe("navigation");
  });

  it("login only as a leading/whole path, never inside event paths", () => {
    expect(classifyItem(item("Opening keynote of the day", "https://example.com/sessions/opening-keynote"), page)).toBeNull();
    expect(classifyItem(item("Weekly meetup in Berlin", "https://example.com/join/weekly-meetup-berlin"), page)).toBeNull();
    expect(classifyItem(item("Log in to continue reading", "https://example.com/account/login"), page)).toBe("login");
  });

  it("short and non-Latin titles, and fr/es/it placeholders", () => {
    expect(isPlaceholderTitle("新闻")).toBe(false);
    expect(isPlaceholderTitle("Go")).toBe(true);
    expect(isPlaceholderTitle("Go", { articleLikeLink: true })).toBe(false);
    for (const t of ["Lire la suite", "Leer más", "Leggi di più", "Learn more about our values"]) expect(isPlaceholderTitle(t), t).toBe(true);
  });

  it.each([
    item("Shipping faster with smaller pull requests", "https://example.com/blog/shipping-faster-with-small-prs"),
    item("Release notes", "https://example.com/blog/2026/11/10/release"),
    item("Example files S-1 with the SEC for proposed offering", "https://example.com/news/s1-sec"),
    item("A post on another site we link to", "https://other.example.org/2026/11/post"),
    item("Video: the full keynote", "https://www.youtube.com/watch?v=abc123XYZ90"),
  ])("plausible entry: %j", (it) => {
    expect(classifyItem(it, page)).toBeNull();
  });

  it("flags brand-named show links and broadcast sections on a news front page", () => {
    const front = new URL("https://www.tagesschau.de/");
    expect(classifyItem(item("tagesschau in 100 Sekunden", "https://www.tagesschau.de/tagesschau-in-100-sekunden/"), front)).toBe("brandNavigation");
    // Brand-led titles with a dated/id link are newsroom entries.
    expect(classifyItem(item("Tagesschau startet App", "https://www.tagesschau.de/inland/2026/11/app-start.html"), front)).toBeNull();
    expect(classifyItem(item("Introducing Stripe Tax", "https://stripe.com/blog/introducing-stripe-tax"), new URL("https://stripe.com/blog"))).toBeNull();
    expect(classifyItem(item("Bilder des Tages aus aller Welt", "https://www.tagesschau.de/multimedia/bilder/blickpunkte-10558.html"), front)).toBe("offScope");
    expect(classifyItem(item("« La Bataille de Harvard », sur Arte.tv", "https://www.tagesschau.de/kultur/la-bataille-de-harvard-sur-arte-tv-100.html"), front)).toBeNull();
    expect(classifyItem(item("Schüsse in Hamburger Hafencity", "https://www.tagesschau.de/inland/gesellschaft/hamburg-schuesse-100.html"), front)).toBeNull();
  });
});

describe("quality helpers", () => {
  it("recognises entry-like URLs", () => {
    expect(isArticleLikeLink("https://www.bbc.com/news/articles/c3rryrryk59zo")).toBe(true);
    expect(isArticleLikeLink("https://books.toscrape.com/catalogue/a-light-in-the-attic_1000/index.html")).toBe(true);
    expect(isArticleLikeLink("https://www.berlin.de/aktuelles/10749467-958090-berlin-erinnert.html")).toBe(true);
    expect(isArticleLikeLink("https://example.com/item?id=4711")).toBe(true);
    expect(isArticleLikeLink("https://stripe.com/blog/product")).toBe(false);
    expect(isArticleLikeLink("https://www.ecb.europa.eu/mopo/intro/html/index.en.html")).toBe(false);
  });

  it("compares sites by registrable label and links without tracking params", () => {
    expect(siteLabel("www.bbc.co.uk")).toBe("bbc");
    expect(siteLabel("news.faz.net")).toBe("faz");
    expect(linkKey("https://www.example.com/a/?utm_source=x&id=2#top")).toBe(linkKey("https://example.com/a?id=2"));
  });

  const art = (title: string, link: string, date = true): FetchedFeedArticle => ({
    title,
    link,
    content: "",
    author: null,
    publishedAt: date ? new Date("2026-11-10T10:00:00Z") : null,
    imageUrl: null,
    externalId: link,
    categories: [],
  });

  it("requires at least three distinct plausible items", () => {
    const same = [1, 2, 3, 4].map(() => art("The same story again and again", "https://example.com/blog/the-same-story"));
    expect(assessPreviewQuality(same, { pageUrl: "https://example.com/blog" })).toMatchObject({ verdict: "reject", rejectReason: "tooFewPlausibleItems" });
    const three = ["first-story-here", "second-story-here", "third-story-here"].map((s) => art(`Story ${s.replace(/-/g, " ")}`, `https://example.com/blog/${s}`));
    expect(assessPreviewQuality(three, { pageUrl: "https://example.com/blog" }).verdict).not.toBe("reject");
  });

  it("rejects lists that are mostly junk and labels borderline ones", () => {
    const good = ["alpha-release-notes", "beta-release-notes", "gamma-release-notes", "delta-release-notes", "epsilon-release-notes"].map((s) =>
      art(`Release ${s.split("-")[0]} is out now`, `https://example.com/blog/${s}`),
    );
    const junk = ["Apply", "Read more", "Login", "Home", "Kontakt", "Menu"].map((t, i) => art(t, `https://example.com/x${i}`));
    expect(assessPreviewQuality([...good.slice(0, 3), ...junk], { pageUrl: "https://example.com/blog" }).verdict).toBe("reject");
    expect(assessPreviewQuality(good, { pageUrl: "https://example.com/blog" })).toMatchObject({ verdict: "ok", reasons: [] });
    const undated = good.map((a) => ({ ...a, publishedAt: null }));
    expect(assessPreviewQuality(undated, { pageUrl: "https://example.com/blog" })).toMatchObject({ verdict: "ok", reasons: [], notes: ["missingDates"] });
    const oneStray = [...good, art("Read more", "https://example.com/blog/x")];
    expect(assessPreviewQuality(oneStray, { pageUrl: "https://example.com/blog" }).verdict).toBe("ok");
    const withJunk = [...good, ...["Read more", "Weiterlesen", "Lire la suite"].map((t, i) => art(t, `https://example.com/blog/x${i}`))];
    expect(assessPreviewQuality(withJunk, { pageUrl: "https://example.com/blog" }).reasons).toContain("mixedItems");
  });

  it("labels a section URL whose items leave the section", () => {
    const elsewhere = ["one-big-story", "two-big-story", "three-big-story", "four-big-story", "five-big-story"].map((s) =>
      art(`The ${s.replace(/-/g, " ")} today`, `https://example.com/shop/${s}`),
    );
    expect(assessPreviewQuality(elsewhere, { pageUrl: "https://example.com/news" }).reasons).toContain("outsideSection");
  });

  it("rejects chrome lists that are not entry-like", () => {
    const nav = ["Solutions for data teams", "Solutions for marketing teams", "Solutions for support teams", "Solutions for sales teams"].map((t) =>
      art(t, `https://example.com/solutions/${t.split(" ")[2]}-teams`),
    );
    expect(assessPreviewQuality(nav, { pageUrl: "https://example.com/", insideChrome: true })).toMatchObject({ verdict: "reject", rejectReason: "navigationChrome" });
  });
});

describe("time budget on a large real page (Spiegel, injected clock)", () => {
  const SPIEGEL = () => {
    const site = SITES.find((s) => s.id === "news-de-2")!;
    return { html: readFileSync(path.join(FIXTURES, "news-de-2.html"), "utf8"), url: site.url };
  };
  /** A clock that advances `step` ms per read (one read per evaluated group + the start). */
  const clock = (step: number) => {
    let t = -step;
    return () => (t += step);
  };
  // Parsing and validating this page takes seconds: compute the unlimited reference once.
  let full: ReturnType<typeof suggestFeedCandidatesDetailed> | undefined;
  const reference = () => {
    const { html, url } = SPIEGEL();
    return (full ??= suggestFeedCandidatesDetailed(html, url, UNLIMITED));
  };

  it("the largest groups of this page are chrome the gate rejects: the first real list is only reached after several groups", () => {
    const { html, url } = SPIEGEL();
    expect(reference().work!.budgetExhausted).toBe(false); // an unlimited budget never reports exhaustion
    expect(reference().candidates.length).toBeGreaterThan(0);
    // With a budget that is spent after 2 groups, the old behaviour ("stop at the deadline") offered nothing.
    const hurried = suggestFeedCandidatesDetailed(html, url, { now: clock(SUGGEST_TIME_BUDGET_MS / 2 + 1) });
    expect(hurried.work!.groupsEvaluated).toBeGreaterThan(2);
  }, SLOW);

  it("budget spent before any candidate exists: keeps validating until one survives, then stops with budgetExhausted", () => {
    const { html, url } = SPIEGEL();
    const r = suggestFeedCandidatesDetailed(html, url, { now: clock(SUGGEST_TIME_BUDGET_MS / 2 + 1) });
    expect(r.candidates.length).toBeGreaterThan(0);
    expect(r.work!.budgetExhausted).toBe(true);
    // Stopped early: the best of what was evaluated, not the whole page.
    expect(r.work!.groupsEvaluated).toBeLessThan(reference().work!.groupsEvaluated);
    expect(r.candidates.length).toBeLessThanOrEqual(reference().candidates.length);
  }, SLOW);

  it("the hard limit still bounds the work when nothing survives", () => {
    const { html, url } = SPIEGEL();
    // Every read costs 2 s: the soft budget (1.5 s) is gone at once, the hard limit (4 × 1.5 s) after 3 groups.
    const r = suggestFeedCandidatesDetailed(html, url, { now: clock(2000) });
    expect(HARD_BUDGET_FACTOR * SUGGEST_TIME_BUDGET_MS).toBe(6000);
    expect(r.work).toMatchObject({ groupsEvaluated: 3, budgetExhausted: true });
    expect(r.candidates).toEqual([]);
  }, SLOW);
});
