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
});
