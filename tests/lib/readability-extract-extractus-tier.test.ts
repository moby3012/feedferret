import { describe, it, expect, vi } from "vitest";

// Isolated from readability-extract.test.ts: mocking Defuddle/Readability
// module-wide here would break that file's own (real) extraction tests if
// they shared a file, since vitest module mocks are file-scoped.
vi.mock("defuddle", () => ({
  default: class {
    parse() {
      return null;
    }
  },
}));
vi.mock("@mozilla/readability", () => ({
  Readability: class {
    parse() {
      return null;
    }
  },
}));

const REALISTIC_ARTICLE_HTML = `
<!doctype html>
<html>
<head><title>The Long Life of Old Lighthouses</title></head>
<body>
  <article>
    <h1>The Long Life of Old Lighthouses</h1>
    <p>Lighthouses have guided sailors along rocky coastlines for centuries, standing
    as solitary sentinels against the crashing waves and the long dark nights at sea.
    Many of the oldest towers were built from stone quarried nearby, hauled up cliffs
    by hand, and assembled by crews who lived for months at a time in isolated camps.</p>
    <p>The lamps themselves evolved considerably over the decades. Early keepers relied
    on whale oil and simple wicks, requiring constant trimming and refilling through the
    night. Later, Fresnel lenses concentrated the light into a powerful beam that could
    be seen for miles, dramatically reducing the number of ships wrecked on hidden reefs
    and sandbars near the coast.</p>
  </article>
</body>
</html>
`;

describe("extractReadableContent — @extractus/article-extractor fallback tier", () => {
  it("falls through to extractus when Defuddle and Readability both fail", async () => {
    const { extractReadableContent } = await import("../../lib/readability-extract");
    const result = await extractReadableContent(REALISTIC_ARTICLE_HTML, "https://example.com/lighthouses");
    expect(result.extractedBy).toBe("extractus");
    expect(result.markdown).toContain("Fresnel lenses");
  });
});
