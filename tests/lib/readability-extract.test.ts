import { describe, it, expect } from "vitest";
import { extractReadableContent } from "../../lib/readability-extract";

// ── extractReadableContent — realistic article page ──────────────────────────

const REALISTIC_ARTICLE_HTML = `
<!doctype html>
<html>
<head>
  <title>The Long Life of Old Lighthouses</title>
  <meta property="og:title" content="The Long Life of Old Lighthouses" />
</head>
<body>
  <nav>
    <a href="/">Home</a>
    <a href="/about">About</a>
    <a href="/contact">Contact</a>
  </nav>
  <aside class="sidebar">
    <div class="ad">Buy our newsletter subscription today for amazing deals!</div>
    <div class="promo">Sponsored: click here to win a free cruise vacation package now.</div>
  </aside>
  <article>
    <h1>The Long Life of Old Lighthouses</h1>
    <p class="byline">By A. Keeper</p>
    <p>Lighthouses have guided sailors along rocky coastlines for centuries, standing
    as solitary sentinels against the crashing waves and the long dark nights at sea.
    Many of the oldest towers were built from stone quarried nearby, hauled up cliffs
    by hand, and assembled by crews who lived for months at a time in isolated camps.</p>
    <p>The lamps themselves evolved considerably over the decades. Early keepers relied
    on whale oil and simple wicks, requiring constant trimming and refilling through the
    night. Later, Fresnel lenses concentrated the light into a powerful beam that could
    be seen for miles, dramatically reducing the number of ships wrecked on hidden reefs
    and sandbars near the coast.</p>
    <p>Today, most lighthouses are automated, and the keepers who once tended them are
    gone, but many of the structures remain standing, preserved as historic landmarks
    and monuments to the age of sail. Visitors can climb the spiral staircases and look
    out over the same water those keepers watched for so many quiet years.</p>
  </article>
  <footer>Copyright 2024 Example Publishing. All rights reserved. Privacy policy.</footer>
</body>
</html>
`;

describe("extractReadableContent — realistic article", () => {
  it("extracts using defuddle or readability, not none", async () => {
    const result = await extractReadableContent(REALISTIC_ARTICLE_HTML, "https://example.com/lighthouses");
    expect(["defuddle", "readability"]).toContain(result.extractedBy);
  });

  it("produces markdown containing the article prose", async () => {
    const result = await extractReadableContent(REALISTIC_ARTICLE_HTML, "https://example.com/lighthouses");
    expect(result.markdown).toBeTruthy();
    expect(result.markdown).toContain("Lighthouses have guided sailors");
    expect(result.markdown).toContain("Fresnel lenses");
  });

  it("excludes nav/sidebar/footer boilerplate from the markdown", async () => {
    const result = await extractReadableContent(REALISTIC_ARTICLE_HTML, "https://example.com/lighthouses");
    expect(result.markdown).not.toContain("win a free cruise");
    expect(result.markdown).not.toContain("Buy our newsletter subscription");
    expect(result.markdown).not.toContain("Copyright 2024 Example Publishing");
  });

  it("reports a positive word count", async () => {
    const result = await extractReadableContent(REALISTIC_ARTICLE_HTML, "https://example.com/lighthouses");
    expect(result.wordCount).toBeGreaterThan(0);
  });

  it("extracts a title", async () => {
    const result = await extractReadableContent(REALISTIC_ARTICLE_HTML, "https://example.com/lighthouses");
    expect(result.title).toBeTruthy();
    expect(result.title).toContain("Lighthouses");
  });

  it("returns sanitized html alongside the markdown", async () => {
    const result = await extractReadableContent(REALISTIC_ARTICLE_HTML, "https://example.com/lighthouses");
    expect(result.html).toBeTruthy();
    expect(result.html).not.toContain("<script");
  });
});

// ── extractReadableContent — thin content page ───────────────────────────────

const THIN_CONTENT_HTML = `
<!doctype html>
<html>
<head><title>Untitled</title></head>
<body>
  <nav><a href="/">Home</a></nav>
  <div id="app"></div>
</body>
</html>
`;

describe("extractReadableContent — thin/near-empty page", () => {
  it("falls back gracefully (readability or none) without throwing", async () => {
    const result = await extractReadableContent(THIN_CONTENT_HTML, "https://example.com/empty");
    expect(["readability", "none"]).toContain(result.extractedBy);
  });

  it("has zero word count when extraction yields nothing", async () => {
    const result = await extractReadableContent(THIN_CONTENT_HTML, "https://example.com/empty");
    if (result.extractedBy === "none") {
      expect(result.wordCount).toBe(0);
      expect(result.html).toBeNull();
      expect(result.markdown).toBeNull();
    }
  });
});

// ── extractReadableContent — junk/empty input ─────────────────────────────────

describe("extractReadableContent — junk input", () => {
  it("returns extractedBy 'none' with null html/markdown, without throwing", async () => {
    const result = await extractReadableContent("<html></html>", "https://example.com/junk");
    expect(result.extractedBy).toBe("none");
    expect(result.html).toBeNull();
    expect(result.markdown).toBeNull();
    expect(result.wordCount).toBe(0);
  });

  it("does not throw on empty string input", async () => {
    await expect(extractReadableContent("", "https://example.com/blank")).resolves.toBeDefined();
  });
});

// ── crash-hardening: jsdom CSS parser must not abort extraction ───────────────

describe("extractReadableContent — <style> crash hardening", () => {
  // jsdom's CSS engine throws on `border: var(--border-width,…)` shorthands.
  // The page below embeds exactly that; extraction must strip <style> and still
  // return the article rather than throwing (regression for the production
  // "border-width" sync crash and Wired full-text failing).
  const BORDER_VAR_CSS_ARTICLE = `
<!doctype html><html><head><title>CSS Trap</title>
<style>:root{--border-width:1px}.box{border:var(--border-width,1px) solid #000}</style>
</head><body>
<article><h1>Motion Sensors Without Cameras</h1>
<p>The good news is you don't need a camera to secure your home or detect intruders. I tested several motion sensors and alternative systems that can alert you of activity just as effectively without sacrificing your privacy over many weeks of real use.</p>
<p>Each device here was evaluated for reliability, ease of setup, privacy posture, and how well it integrated with common smart-home hubs, so you can pick one that fits your household without adding another camera to your life.</p>
</article></body></html>`;

  it("does not throw and extracts content despite a var() border shorthand in <style>", async () => {
    const result = await extractReadableContent(BORDER_VAR_CSS_ARTICLE, "https://example.com/css-trap");
    expect(result.html).toBeTruthy();
    expect(result.extractedBy === "defuddle" || result.extractedBy === "readability").toBe(true);
    expect((result.html || "").toLowerCase()).toContain("motion sensors");
  });
});

// ── JSON-LD articleBody fallback for paywalled/truncated DOMs ──────────────────

describe("extractReadableContent — JSON-LD articleBody fallback", () => {
  const bodyText = Array.from({ length: 12 }, (_, i) =>
    `Paragraph ${i + 1}: this is the full article body that only appears in the schema.org structured data, not in the visible paywalled DOM, and it is long enough to clear the extraction threshold comfortably.`,
  ).join("\\n\\n");

  const PAYWALLED_HTML = `
<!doctype html><html><head><title>Paywalled Story</title>
<script type="application/ld+json">${JSON.stringify({
    "@context": "https://schema.org",
    "@type": "NewsArticle",
    headline: "Paywalled Story",
    isAccessibleForFree: false,
    articleBody: bodyText,
  })}</script>
</head><body>
<article><h1>Paywalled Story</h1><p>Subscribe to read the rest.</p></article>
</body></html>`;

  it("recovers full text from schema.org articleBody when the DOM body is a thin teaser", async () => {
    const result = await extractReadableContent(PAYWALLED_HTML, "https://example.com/paywalled");
    // Recovery may come from Defuddle's own JSON-LD awareness or our explicit
    // jsonld fallback — either way the full body must be surfaced, not "none".
    expect(result.extractedBy).not.toBe("none");
    const plain = (result.html || "").replace(/<[^>]*>/g, " ").replace(/\s+/g, " ").trim();
    expect(plain.length).toBeGreaterThan(400);
    expect(plain).toContain("Paragraph 12");
  });
});
