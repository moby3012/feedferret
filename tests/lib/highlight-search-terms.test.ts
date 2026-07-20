import { describe, expect, it } from "vitest";
import { extractHighlightTerms, highlightText } from "../../lib/highlight-search-terms";
import { renderToStaticMarkup } from "react-dom/server";
import React from "react";

describe("extractHighlightTerms", () => {
  it("extracts plain free-text words", () => {
    expect(extractHighlightTerms("nextcloud tailscale")).toEqual(["nextcloud", "tailscale"]);
  });

  it("keeps quoted phrases as single terms", () => {
    expect(extractHighlightTerms('"open source"')).toEqual(["open source"]);
  });

  it("drops the OR operator token", () => {
    expect(extractHighlightTerms("nextcloud OR tailscale")).toEqual(["nextcloud", "tailscale"]);
  });

  it("drops negated terms", () => {
    expect(extractHighlightTerms("nextcloud -tailscale !docker")).toEqual(["nextcloud"]);
  });

  it("drops field-scoped tokens like feed: and is:", () => {
    expect(extractHighlightTerms("feed:heise is:unread nextcloud")).toEqual(["nextcloud"]);
  });

  it("drops label shorthand tokens", () => {
    expect(extractHighlightTerms("#homelab nextcloud")).toEqual(["nextcloud"]);
  });

  it("returns an empty array for an empty query", () => {
    expect(extractHighlightTerms("")).toEqual([]);
    expect(extractHighlightTerms("   ")).toEqual([]);
  });
});

describe("highlightText", () => {
  it("returns the original text unchanged when there are no terms", () => {
    expect(highlightText("Hello world", [])).toBe("Hello world");
  });

  it("wraps a case-insensitive match in <mark>", () => {
    const html = renderToStaticMarkup(React.createElement(React.Fragment, null, highlightText("Hello World", ["world"])));
    expect(html).toContain("<mark");
    expect(html).toContain("World");
  });

  it("does not blow up on regex special characters in the term", () => {
    expect(() => highlightText("Cost: $5 (approx.)", ["$5", "(approx.)"])).not.toThrow();
    const html = renderToStaticMarkup(
      React.createElement(React.Fragment, null, highlightText("Cost: $5 (approx.)", ["$5", "(approx.)"])),
    );
    expect(html).toContain("<mark");
  });

  it("leaves text without a match untouched", () => {
    expect(highlightText("Hello world", ["xyz"])).toBe("Hello world");
  });
});
