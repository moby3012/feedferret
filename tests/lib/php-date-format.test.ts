import { describe, expect, it } from "vitest";
import { parsePhpDate } from "../../lib/php-date-format";
import { parseLooseDate, scrapedDateFrom } from "../../lib/feed-item-fields";
import { buildXPathArticles } from "../../lib/feed-parse-core";

// All expectations are built with the local-time Date constructor: parsed values are
// server-local when the string carries no zone, so the suite passes in any TZ.
const local = (y: number, mo: number, d: number, h = 0, mi = 0, s = 0, ms = 0) => new Date(y, mo - 1, d, h, mi, s, ms);
const NOW = local(2026, 11, 12, 15, 30, 45);

describe("parsePhpDate", () => {
  it("reads 12.08.2026 with d.m.Y as 12 August, not 8 December", () => {
    expect(parsePhpDate("12.08.2026", "d.m.Y")).toEqual(local(2026, 8, 12));
  });

  it("handles day/month with and without leading zeros", () => {
    expect(parsePhpDate("5.8.2026", "j.n.Y")).toEqual(local(2026, 8, 5));
    expect(parsePhpDate("05.08.2026", "j.n.Y")).toEqual(local(2026, 8, 5));
    expect(parsePhpDate("5.8.2026", "d.m.Y")).toEqual(local(2026, 8, 5));
  });

  it("supports slashes, dashes and a 24h time", () => {
    expect(parsePhpDate("12/08/2026 14:05", "d/m/Y H:i")).toEqual(local(2026, 8, 12, 14, 5));
    expect(parsePhpDate("12/08/2026 14:05", "m/d/Y H:i")).toEqual(local(2026, 12, 8, 14, 5));
    expect(parsePhpDate("2026-08-12 14:05:09", "Y-m-d H:i:s")).toEqual(local(2026, 8, 12, 14, 5, 9));
    expect(parsePhpDate("9:05", "G:i", { now: NOW })).toEqual(local(2026, 11, 12, 9, 5));
  });

  it("normalises whitespace (nbsp, newlines, padding) in the scraped text", () => {
    expect(parsePhpDate("  12.08.2026 \n 14:05 ", "d.m.Y H:i")).toEqual(local(2026, 8, 12, 14, 5));
  });

  it("matches a format space against a whitespace run", () => {
    for (const space of [" ", "   ", "\t", "\n", "\u00a0\t\n"]) {
      expect(parsePhpDate(`12.08.2026${space}14:05`, "d.m.Y H:i")).toEqual(local(2026, 8, 12, 14, 5));
    }
    expect(parsePhpDate("12.08.2026 14:05", "d.m.Y  H:i")).toEqual(local(2026, 8, 12, 14, 5));
    expect(parsePhpDate("12.08.202614:05", "d.m.Y H:i")).toBeNull();
  });

  it("leaves escaped literal dots for the format after month and day names", () => {
    expect(parsePhpDate("12 Aug. 2026", "j M\\. Y")).toEqual(local(2026, 8, 12));
    expect(parsePhpDate("Wed. 12 Aug 2026", "D\\. j M Y")).toEqual(local(2026, 8, 12));
    expect(parsePhpDate("12 Aug 2026", "j M\\. Y")).toBeNull();
  });

  it("accepts lowercase t in the ISO shorthand while keeping escaped literals exact", () => {
    expect(parsePhpDate("2026-08-12t14:05:00Z", "c")).toEqual(new Date(Date.UTC(2026, 7, 12, 14, 5)));
    expect(parsePhpDate("2026-08-12x14:05:00Z", "c")).toBeNull();
    expect(parsePhpDate("2026-08-12t14:05:00Z", "Y-m-d\\TH:i:sP")).toBeNull();
  });

  it("parses English and German month names", () => {
    expect(parsePhpDate("August 12, 2026", "F d, Y")).toEqual(local(2026, 8, 12));
    expect(parsePhpDate("Aug 12, 2026", "M d, Y")).toEqual(local(2026, 8, 12));
    expect(parsePhpDate("12. August 2026", "j. F Y")).toEqual(local(2026, 8, 12));
    expect(parsePhpDate("3. März 2026", "j. F Y")).toEqual(local(2026, 3, 3));
    expect(parsePhpDate("3. Maerz 2026", "j. F Y")).toEqual(local(2026, 3, 3));
    expect(parsePhpDate("3. mär. 2026", "j. M Y")).toEqual(local(2026, 3, 3));
    expect(parsePhpDate("24. Dezember 2026", "j. F Y")).toEqual(local(2026, 12, 24));
    expect(parsePhpDate("7. OKT 2026", "j. M Y")).toEqual(local(2026, 10, 7));
    expect(parsePhpDate("1 Sept 2026", "j M Y")).toEqual(local(2026, 9, 1));
  });

  it("does not take a prefix of a longer word for a month", () => {
    expect(parsePhpDate("12 Maybe 2026", "j F Y")).toBeNull();
    expect(parsePhpDate("12 Foo 2026", "j F Y")).toBeNull();
  });

  it("accepts (and ignores) day names", () => {
    expect(parsePhpDate("Wed, 12 Aug 2026", "D, j M Y")).toEqual(local(2026, 8, 12));
    expect(parsePhpDate("Mittwoch, 12. August 2026", "l, j. F Y")).toEqual(local(2026, 8, 12));
    expect(parsePhpDate("Fooday, 12 Aug 2026", "l, j M Y")).toBeNull();
  });

  it("expands 2-digit years like PHP (<70 → 20xx, ≥70 → 19xx)", () => {
    expect(parsePhpDate("12.08.26", "d.m.y")).toEqual(local(2026, 8, 12));
    expect(parsePhpDate("12.08.69", "d.m.y")).toEqual(local(2069, 8, 12));
    expect(parsePhpDate("12.08.70", "d.m.y")).toEqual(local(1970, 8, 12));
    expect(parsePhpDate("01.01.99", "d.m.y")).toEqual(local(1999, 1, 1));
    expect(parsePhpDate("12.08.202", "d.m.y")).toBeNull();
    expect(parsePhpDate("12.08.26", "d.m.Y")).toBeNull();
  });

  it("handles the 12h clock with AM/PM", () => {
    expect(parsePhpDate("08/12/2026 12:00 AM", "m/d/Y h:i A")).toEqual(local(2026, 8, 12, 0, 0));
    expect(parsePhpDate("08/12/2026 12:30 PM", "m/d/Y h:i A")).toEqual(local(2026, 8, 12, 12, 30));
    expect(parsePhpDate("08/12/2026 1:05 pm", "m/d/Y g:i a")).toEqual(local(2026, 8, 12, 13, 5));
    expect(parsePhpDate("08/12/2026 11:59 p.m.", "m/d/Y h:i a")).toEqual(local(2026, 8, 12, 23, 59));
    expect(parsePhpDate("08/12/2026 11:59 AM", "m/d/Y h:i A")).toEqual(local(2026, 8, 12, 11, 59));
    // 13 o'clock PM / 0 o'clock AM are not real 12h times.
    expect(parsePhpDate("08/12/2026 13:00 PM", "m/d/Y h:i A")).toBeNull();
    expect(parsePhpDate("08/12/2026 0:00 AM", "m/d/Y g:i A")).toBeNull();
    // Meridian without an hour is a format error.
    expect(parsePhpDate("08/12/2026 PM", "m/d/Y A")).toBeNull();
  });

  it("supports escaped characters and literals", () => {
    expect(parsePhpDate("12.08.2026 um 14:05", "d.m.Y \\u\\m H:i")).toEqual(local(2026, 8, 12, 14, 5));
    expect(parsePhpDate("12.08.2026 14:05 Uhr", "d.m.Y H:i \\U\\h\\r")).toEqual(local(2026, 8, 12, 14, 5));
    expect(parsePhpDate("Posted: 12.08.2026", "\\P\\o\\s\\t\\e\\d: d.m.Y")).toEqual(local(2026, 8, 12));
    expect(parsePhpDate("Posted: 12.08.2026", "\\P\\o\\s\\t\\e\\n: d.m.Y")).toBeNull();
  });

  it("supports unix timestamps", () => {
    expect(parsePhpDate("1786530000", "U")).toEqual(new Date(1786530000 * 1000));
    expect(parsePhpDate("-86400", "U")).toEqual(new Date(-86400 * 1000));
    expect(parsePhpDate("12.08.2026", "U")).toBeNull();
  });

  it("applies explicit time zones when the string has one", () => {
    expect(parsePhpDate("2026-08-12T14:05:00+02:00", "c")).toEqual(new Date(Date.UTC(2026, 7, 12, 12, 5)));
    expect(parsePhpDate("2026-08-12T14:05:00Z", "c")).toEqual(new Date(Date.UTC(2026, 7, 12, 14, 5)));
    expect(parsePhpDate("2026-08-12T14:05:00.250-0530", "c")).toEqual(new Date(Date.UTC(2026, 7, 12, 19, 35, 0, 250)));
    expect(parsePhpDate("Wed, 12 Aug 2026 14:05:00 +0200", "r")).toEqual(new Date(Date.UTC(2026, 7, 12, 12, 5)));
    expect(parsePhpDate("12.08.2026 14:05 UTC", "d.m.Y H:i T")).toEqual(new Date(Date.UTC(2026, 7, 12, 14, 5)));
  });

  it("! and | reset unparsed fields to the epoch, otherwise a date-only format is local midnight", () => {
    expect(parsePhpDate("14:05", "!H:i")).toEqual(local(1970, 1, 1, 14, 5));
    expect(parsePhpDate("2026", "Y|")).toEqual(local(2026, 1, 1));
    expect(parsePhpDate("12.08.2026", "!d.m.Y")).toEqual(local(2026, 8, 12));
    expect(parsePhpDate("12.08.2026", "d.m.Y")).toEqual(local(2026, 8, 12, 0, 0, 0));
  });

  it("fills missing fields deterministically", () => {
    expect(parsePhpDate("August 2026", "F Y", { now: NOW })).toEqual(local(2026, 8, 1));
    expect(parsePhpDate("12. August", "j. F", { now: NOW })).toEqual(local(2026, 8, 12));
    expect(parsePhpDate("14:05", "H:i", { now: NOW })).toEqual(local(2026, 11, 12, 14, 5));
    expect(parsePhpDate("14", "H", { now: NOW })).toEqual(local(2026, 11, 12, 14, 0, 0));
  });

  it("supports ?, * and + wildcards", () => {
    expect(parsePhpDate("x12.08.2026", "?d.m.Y")).toEqual(local(2026, 8, 12));
    expect(parsePhpDate("Heute 12.08.2026", "* d.m.Y")).toEqual(local(2026, 8, 12));
    expect(parsePhpDate("12.08.2026 whatever follows", "d.m.Y+")).toEqual(local(2026, 8, 12));
  });

  it("returns null (never a guess) for strings that do not match the format", () => {
    for (const [input, format] of [
      ["", "d.m.Y"],
      ["   ", "d.m.Y"],
      ["12.08.2026", ""],
      ["not a date", "d.m.Y"],
      ["12.08.2026 trailing", "d.m.Y"],
      ["12.08.2026", "d.m.Y H:i"],
      ["12-08-2026", "d.m.Y"],
      ["2026-08-12", "d.m.Y"],
      ["12.8.2026", "d.m.Y H"],
      ["12.08.20", "d.m.Y"],
      ["12.08.2026 14:5", "d.m.Y H:i"],
      ["12.08.2026 14:05", "d.m.Y"],
      ["12.08.2026", "\\"],
    ] as const) {
      expect(parsePhpDate(input, format), `${input} / ${format}`).toBeNull();
    }
  });

  it("rejects impossible calendar dates and clock times instead of rolling over", () => {
    expect(parsePhpDate("31.02.2026", "d.m.Y")).toBeNull();
    expect(parsePhpDate("29.02.2026", "d.m.Y")).toBeNull();
    expect(parsePhpDate("29.02.2028", "d.m.Y")).toEqual(local(2028, 2, 29));
    expect(parsePhpDate("00.08.2026", "d.m.Y")).toBeNull();
    expect(parsePhpDate("12.13.2026", "d.m.Y")).toBeNull();
    expect(parsePhpDate("12.00.2026", "d.m.Y")).toBeNull();
    expect(parsePhpDate("12.08.2026 24:00", "d.m.Y H:i")).toBeNull();
    expect(parsePhpDate("12.08.2026 23:60", "d.m.Y H:i")).toBeNull();
    expect(parsePhpDate("12.08.2026 23:59:60", "d.m.Y H:i:s")).toBeNull();
    expect(parsePhpDate("2026-08-12T10:00:00+25:00", "c")).toBeNull();
  });

  it("cannot be tricked into catastrophic work by hostile input", () => {
    const hostile = "1".repeat(100_000);
    const start = performance.now();
    expect(parsePhpDate(hostile, "d.m.Y")).toBeNull();
    expect(parsePhpDate(`${"a".repeat(100_000)}`, "* d.m.Y")).toBeNull();
    expect(performance.now() - start).toBeLessThan(500);
  });
});

describe("parseLooseDate (no format configured)", () => {
  it("reads dot-separated dates day-first, never US order", () => {
    expect(parseLooseDate("12.08.2026")).toEqual(local(2026, 8, 12));
    expect(parseLooseDate("1.2.2026")).toEqual(local(2026, 2, 1));
    expect(parseLooseDate("12.08.26")).toEqual(local(2026, 8, 12));
    expect(parseLooseDate("12.08.2026 14:05")).toEqual(local(2026, 8, 12, 14, 5));
    expect(parseLooseDate("12.08.2026, 14:05:09")).toEqual(local(2026, 8, 12, 14, 5, 9));
    expect(parseLooseDate("12.08.2026 14:05 Uhr")).toEqual(local(2026, 8, 12, 14, 5));
  });

  it("returns null for impossible dotted dates rather than rolling over", () => {
    expect(parseLooseDate("31.02.2026")).toBeNull();
    expect(parseLooseDate("12.13.2026")).toBeNull();
  });

  it("keeps the engine's parsing for everything else", () => {
    expect(parseLooseDate("2026-08-12T14:05:00Z")).toEqual(new Date(Date.UTC(2026, 7, 12, 14, 5)));
    expect(parseLooseDate("Wed, 12 Aug 2026 14:05:00 GMT")).toEqual(new Date(Date.UTC(2026, 7, 12, 14, 5)));
    expect(parseLooseDate("garbage")).toBeNull();
  });
});

describe("scrapedDateFrom", () => {
  it("parses strictly with the configured format and returns null on mismatch", () => {
    expect(scrapedDateFrom("12.08.2026", "d.m.Y")).toEqual(local(2026, 8, 12));
    expect(scrapedDateFrom("12.08.2026", "m.d.Y")).toEqual(local(2026, 12, 8));
    // Parseable by the engine, but not by the configured format → no guess.
    expect(scrapedDateFrom("2026-08-12", "d.m.Y")).toBeNull();
    expect(scrapedDateFrom("August 12, 2026", "d.m.Y")).toBeNull();
  });

  it("guesses (day-first for dots) when no format is configured, blank format counts as none", () => {
    expect(scrapedDateFrom("12.08.2026")).toEqual(local(2026, 8, 12));
    expect(scrapedDateFrom("12.08.2026", "")).toEqual(local(2026, 8, 12));
    expect(scrapedDateFrom("12.08.2026", "   ")).toEqual(local(2026, 8, 12));
    expect(scrapedDateFrom("")).toBeNull();
    expect(scrapedDateFrom(null, "d.m.Y")).toBeNull();
  });
});

describe("XPath scrape end-to-end: xPathItemTimeFormat", () => {
  const page = `<html><body>
    <div class="e"><a href="/a">A</a><span>12.08.2026</span></div>
    <div class="e"><a href="/b">B</a><span>31.12.2026</span></div>
    <div class="e"><a href="/c">C</a><span>kürzlich</span></div>
  </body></html>`;
  const base = { xPathItem: "//div[@class='e']", xPathItemTitle: ".//a", xPathItemUri: ".//a/@href", xPathItemTimestamp: ".//span" };

  it("uses the configured format", () => {
    const feed = buildXPathArticles(page, "https://scrape.example.net/list", { xpath: { ...base, xPathItemTimeFormat: "d.m.Y" } }, "text/html");
    expect(feed.articles.map((a) => a.publishedAt)).toEqual([local(2026, 8, 12), local(2026, 12, 31), null]);
  });

  it("yields no date when the configured format does not fit", () => {
    const feed = buildXPathArticles(page, "https://scrape.example.net/list", { xpath: { ...base, xPathItemTimeFormat: "Y-m-d" } }, "text/html");
    expect(feed.articles.map((a) => a.publishedAt)).toEqual([null, null, null]);
  });

  it("reads dotted dates day-first without a format", () => {
    const feed = buildXPathArticles(page, "https://scrape.example.net/list", { xpath: base }, "text/html");
    expect(feed.articles.map((a) => a.publishedAt)).toEqual([local(2026, 8, 12), local(2026, 12, 31), null]);
  });
});
