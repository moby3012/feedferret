import { describe, it, expect } from "vitest";
import { htmlText, categoriesFrom } from "../../lib/feed-fetcher";

// xml2js (via rss-parser) represents an element that has BOTH attributes and
// text content as a null-prototype `{ _: text, $: attrs }` object — e.g. from
// `<category domain="https://example.com/cat">Foo</category>`. Coercing that
// object with String()/`+`/template literals throws "Cannot convert object to
// primitive value" because a null-prototype object has no inherited
// toString/valueOf/Symbol.toPrimitive. This exact shape crashed a real feed
// sync (XenForo's RSS categories carry a `domain` attribute).
function mixedContentNode(text: string, attrs: Record<string, string> = {}) {
  return Object.assign(Object.create(null), { _: text, $: attrs });
}

describe("htmlText", () => {
  it("returns plain strings trimmed, unchanged", () => {
    expect(htmlText("  Hello  ")).toBe("Hello");
  });

  it("returns empty string for null/undefined", () => {
    expect(htmlText(null)).toBe("");
    expect(htmlText(undefined)).toBe("");
  });

  it("extracts the text node from an xml2js mixed-content object without throwing", () => {
    const node = mixedContentNode("Announcements", { domain: "https://xenforo.com/community/forums/announcements/" });
    expect(() => htmlText(node)).not.toThrow();
    expect(htmlText(node)).toBe("Announcements");
  });

  it("does not throw and returns empty string for an object with no text node", () => {
    const node = Object.assign(Object.create(null), { $: { domain: "x" } });
    expect(() => htmlText(node)).not.toThrow();
    expect(htmlText(node)).toBe("");
  });
});

describe("categoriesFrom", () => {
  it("extracts plain string categories", () => {
    expect(categoriesFrom(["News", "Updates"])).toEqual(["News", "Updates"]);
  });

  it("extracts categories from xml2js mixed-content nodes (attributed <category> tags)", () => {
    const categories = [
      mixedContentNode("Announcements", { domain: "https://xenforo.com/community/forums/announcements/" }),
      mixedContentNode("News"),
    ];
    expect(() => categoriesFrom(categories)).not.toThrow();
    expect(categoriesFrom(categories)).toEqual(["Announcements", "News"]);
  });

  it("returns an empty array for null/undefined", () => {
    expect(categoriesFrom(null)).toEqual([]);
    expect(categoriesFrom(undefined)).toEqual([]);
  });
});
