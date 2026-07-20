import { describe, it, expect } from "vitest";
import { generateOpml, parseOpml, scraperConfigFromOutline, type OpmlOutline } from "../../lib/opml";

// Flatten the OPML tree (category outlines carry children) to the leaf feed outlines.
function flatten(outlines: OpmlOutline[]): OpmlOutline[] {
  const out: OpmlOutline[] = [];
  for (const outline of outlines) {
    if (outline.children?.length) out.push(...flatten(outline.children));
    else out.push(outline);
  }
  return out;
}

describe("OPML round-trip for page→feed (HTML+XPath) scraper configs", () => {
  it("preserves sourceType and the xpath scraper config through export → import", async () => {
    // A feed exactly as `createFeedFromPage` (M3) would persist it.
    const feed = {
      name: "Example Blog",
      url: "https://example.com/blog",
      htmlUrl: "https://example.com/blog",
      sourceType: "HTML+XPath",
      scraperConfig: JSON.stringify({
        xpath: {
          xPathItem: "//div[contains(concat(' ', normalize-space(@class), ' '), ' post ')]",
          xPathItemTitle: ".//h2",
          xPathItemUri: ".//a/@href",
          xPathItemTimestamp: ".//time/@datetime",
          xPathItemThumbnail: ".//img/@src",
        },
      }),
    };

    const xml = generateOpml([feed]);
    const outlines = await parseOpml(xml);
    const feedOutline = flatten(outlines).find((o) => o.xmlUrl === feed.url);

    expect(feedOutline).toBeDefined();
    expect(feedOutline!.type).toBe("HTML+XPath");

    const config = scraperConfigFromOutline(feedOutline!);
    expect(config.xpath).toBeDefined();
    expect(config.xpath!.xPathItem).toBe(
      "//div[contains(concat(' ', normalize-space(@class), ' '), ' post ')]",
    );
    expect(config.xpath!.xPathItemTitle).toBe(".//h2");
    expect(config.xpath!.xPathItemUri).toBe(".//a/@href");
    expect(config.xpath!.xPathItemTimestamp).toBe(".//time/@datetime");
    expect(config.xpath!.xPathItemThumbnail).toBe(".//img/@src");
  });

  it("round-trips a plain RSS feed without inventing a scraper config", async () => {
    const feed = { name: "Plain RSS", url: "https://example.com/feed.xml", sourceType: "rss" };
    const xml = generateOpml([feed]);
    const outlines = await parseOpml(xml);
    const feedOutline = flatten(outlines).find((o) => o.xmlUrl === feed.url);

    expect(feedOutline).toBeDefined();
    expect(feedOutline!.type).toBe("rss");
    // No xpath extensions → no xpath config reconstructed.
    expect(scraperConfigFromOutline(feedOutline!).xpath).toBeUndefined();
  });

  it("strips XML-illegal control characters from feed names instead of producing unparseable OPML", async () => {
    // XML 1.0 forbids most C0 controls outright — escaping (&#x0;) doesn't
    // make them legal the way it does for < or & — so a stray control
    // character from malformed feed metadata must be dropped, not encoded.
    const feed = {
      name: "Bad\x00Name\x0BHere",
      url: "https://example.com/feed.xml",
      sourceType: "rss",
    };

    const xml = generateOpml([feed]);
    expect(xml).not.toMatch(/[\x00-\x08\x0B\x0C\x0E-\x1F]/);

    // The real regression: this must not throw — a strict XML parser errors
    // out on the whole document, not just the offending outline.
    const outlines = await parseOpml(xml);
    const feedOutline = flatten(outlines).find((o) => o.xmlUrl === feed.url);
    expect(feedOutline!.text).toBe("BadNameHere");
  });
});
