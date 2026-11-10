import { describe, expect, it } from "vitest";
import { translateFreshRssReadFilters } from "../../lib/import/frss-filters";
import { articleMatchesContentFilter, parseContentFilterTerms } from "../../lib/feed-content-filter";

const t = (raw: string) => translateFreshRssReadFilters(raw);

describe("translateFreshRssReadFilters", () => {
  it("keeps a single plain word or quoted phrase as a literal keyword", () => {
    const r = t('sponsored\n"black friday"');
    expect(r.keywordLines).toEqual(["sponsored", "black friday"]);
    expect(r.ruleQueries).toEqual([]);
    expect(r.unsupported).toEqual([]);
  });

  it("translates intitle:/author:/inurl:/intext: and negated field terms exactly", () => {
    expect(t("intitle:hiring").ruleQueries).toEqual(["intitle:hiring"]);
    expect(t("author:bot -intitle:rust").ruleQueries).toEqual(["author:bot -intitle:rust"]);
    expect(t("inurl:/jobs !author:newsroom").ruleQueries).toEqual(["inurl:/jobs -author:newsroom"]);
    expect(t("inurl:/jobs/2024 author:x").ruleQueries).toEqual(["inurl:/jobs/2024 author:x"]);
    expect(t("intext:giveaway").ruleQueries).toEqual(["intext:giveaway"]);
  });

  it("strips quotes around single-word field values", () => {
    expect(t('intitle:"hiring"').ruleQueries).toEqual(["intitle:hiring"]);
  });

  it("expresses a negated plain word as not-in-title AND not-in-content", () => {
    expect(t("promo -crypto").ruleQueries).toEqual(["promo -intitle:crypto -intext:crypto"]);
  });

  it("keeps OR and quoted phrases inside multi-term filters", () => {
    expect(t('intitle:a OR author:b "two words"').ruleQueries).toEqual(['intitle:a OR author:b "two words"']);
  });

  it("flags multi-term plain words as slightly broader instead of silently importing them", () => {
    const r = t("foo bar");
    expect(r.ruleQueries).toEqual(["foo bar"]);
    expect(r.adapted).toHaveLength(1);
  });

  it.each([
    ['intitle:"Show HN"', /multi-word/],
    ["/^\\[dead\\]/", /regular expression/],
    ["#spam", /label/],
    ["(a OR b) c", /parentheses/],
    ["date:P1D/", /no FeedFerret equivalent/],
    ["f:12 spam", /no FeedFerret equivalent/],
    ['-"two words"', /negated phrases/],
    ["is:read", /no FeedFerret equivalent/],
    ["foo OR", /dangling OR/],
    ["intitle:", /empty/],
  ])("never imports %s — reports it", (line, reason) => {
    const r = t(line);
    expect(r.keywordLines).toEqual([]);
    expect(r.ruleQueries).toEqual([]);
    expect(r.unsupported).toHaveLength(1);
    expect(r.unsupported[0].line).toBe(line);
    expect(r.unsupported[0].reason).toMatch(reason);
  });

  it("does not translate partially: one bad term makes the whole line unsupported", () => {
    const r = t("intitle:ok date:P1D/");
    expect(r.ruleQueries).toEqual([]);
    expect(r.unsupported).toHaveLength(1);
  });

  it("splits a realistic FreshRSS filter block per line and ignores blanks and duplicates", () => {
    const r = t("sponsored\n\nintitle:hiring\nsponsored\r\nauthor:bot");
    expect(r.keywordLines).toEqual(["sponsored"]);
    expect(r.ruleQueries).toEqual(["intitle:hiring", "author:bot"]);
  });

  it("literal keywords keep working with the existing per-feed filter engine", () => {
    const terms = parseContentFilterTerms(t("sponsored").keywordLines.join("\n"));
    expect(articleMatchesContentFilter({ title: "A SPONSORED post" }, terms)).toBe(true);
    expect(articleMatchesContentFilter({ title: "Organic" }, terms)).toBe(false);
  });
});
