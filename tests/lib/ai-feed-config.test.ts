import { describe, it, expect } from "vitest";
import {
  parseAiFeedProposal,
  proposeFeedConfig,
  type AiFeedProposal,
} from "../../lib/ai-feed-config";
import type { AiConfig } from "../../lib/ai-summary";

const AI_CONFIG: AiConfig = { provider: "openai", apiKey: "test-key", model: "gpt-4o-mini" };

const BLOG_INDEX_HTML = `
<!DOCTYPE html>
<html>
<head><title>My Blog</title></head>
<body>
  <nav class="site-nav">
    <a href="/">Home</a>
    <a href="/about">About</a>
    <a href="/contact">Contact</a>
    <a href="/archive">Archive</a>
  </nav>
  <main>
    <div class="posts">
      <article class="post">
        <h2><a href="/posts/first-post">The First Post About Lighthouses</a></h2>
        <time datetime="2026-01-01">Jan 1, 2026</time>
        <p>Lighthouses have guided sailors safely to shore for centuries, and this post explores their history in depth.</p>
        <img src="/img/first.jpg" />
      </article>
      <article class="post">
        <h2><a href="/posts/second-post">Second Post: Fresnel Lenses Explained</a></h2>
        <time datetime="2026-01-08">Jan 8, 2026</time>
        <p>The Fresnel lens revolutionized how far a lighthouse beam could travel across open water at night.</p>
        <img src="/img/second.jpg" />
      </article>
      <article class="post">
        <h2><a href="/posts/third-post">Third Post: Keepers and Their Lives</a></h2>
        <time datetime="2026-01-15">Jan 15, 2026</time>
        <p>Lighthouse keepers led isolated lives, tending the light through storms and long lonely winters.</p>
        <img src="/img/third.jpg" />
      </article>
      <article class="post">
        <h2><a href="/posts/fourth-post">Fourth Post: Automation Arrives</a></h2>
        <time datetime="2026-01-22">Jan 22, 2026</time>
        <p>By the late twentieth century, automation had replaced most human keepers at lighthouses worldwide.</p>
        <img src="/img/fourth.jpg" />
      </article>
      <article class="post">
        <h2><a href="/posts/fifth-post">Fifth Post: Modern Preservation</a></h2>
        <time datetime="2026-01-29">Jan 29, 2026</time>
        <p>Preservation societies now work hard to save historic lighthouses from decay and demolition.</p>
        <img src="/img/fifth.jpg" />
      </article>
    </div>
  </main>
  <footer class="site-footer">
    <a href="/privacy">Privacy</a>
    <a href="/terms">Terms</a>
    <a href="/rss">RSS</a>
  </footer>
</body>
</html>`;

const ARTICLE_BODY_PARAGRAPHS = Array.from(
  { length: 8 },
  (_, i) =>
    `<p>This is paragraph number ${i + 1} of the article about lighthouse preservation efforts along the rocky northern coastline, describing in some detail the restoration techniques used by local historical societies.</p>`,
).join("\n        ");

const ARTICLE_HTML = `
<!DOCTYPE html>
<html>
<head><title>Saving the Old Lighthouse</title></head>
<body>
  <nav><a href="/">Home</a></nav>
  <article class="post-body">
    <h1>Saving the Old Lighthouse</h1>
    ${ARTICLE_BODY_PARAGRAPHS}
  </article>
  <footer>Site footer</footer>
</body>
</html>`;

const PAGEFEED_PROPOSAL_JSON = JSON.stringify({
  mode: "pagefeed",
  itemConfig: {
    xPathItem: "//article[contains(concat(' ', normalize-space(@class), ' '), ' post ')]",
    xPathItemTitle: ".//h2",
    xPathItemUri: ".//a/@href",
    xPathItemTimestamp: ".//time/@datetime",
    xPathItemThumbnail: ".//img/@src",
    xPathItemContent: ".//p",
  },
  confidence: 0.85,
  notes: "Repeating post cards under .posts.",
});

const FULLTEXT_PROPOSAL_JSON = JSON.stringify({
  mode: "fulltext",
  fullTextSelector: "article.post-body",
  confidence: 0.9,
  notes: "Main article body identified by class.",
});

describe("parseAiFeedProposal", () => {
  it("parses a valid fulltext JSON payload", () => {
    const result = parseAiFeedProposal(FULLTEXT_PROPOSAL_JSON);
    expect(result).toEqual({
      mode: "fulltext",
      fullTextSelector: "article.post-body",
      confidence: 0.9,
      notes: "Main article body identified by class.",
    });
  });

  it("parses a valid pagefeed JSON payload", () => {
    const result = parseAiFeedProposal(PAGEFEED_PROPOSAL_JSON);
    expect(result?.mode).toBe("pagefeed");
    if (result?.mode === "pagefeed") {
      expect(result.itemConfig.xPathItem).toContain("article");
      expect(result.itemConfig.xPathItemTitle).toBe(".//h2");
      expect(result.confidence).toBe(0.85);
    }
  });

  it("parses JSON wrapped in code fences and surrounding prose", () => {
    const wrapped = `Sure thing! Here's the config:\n\`\`\`json\n${FULLTEXT_PROPOSAL_JSON}\n\`\`\`\nLet me know if you need changes.`;
    const result = parseAiFeedProposal(wrapped);
    expect(result).toEqual({
      mode: "fulltext",
      fullTextSelector: "article.post-body",
      confidence: 0.9,
      notes: "Main article body identified by class.",
    });
  });

  it("returns null for garbage/non-JSON text", () => {
    expect(parseAiFeedProposal("I cannot help with that.")).toBeNull();
    expect(parseAiFeedProposal("")).toBeNull();
    expect(parseAiFeedProposal("{not valid json")).toBeNull();
  });

  it("returns null for wrong-shape JSON (missing xPathItem)", () => {
    const badPagefeed = JSON.stringify({
      mode: "pagefeed",
      itemConfig: { xPathItemTitle: ".//h2" },
      confidence: 0.5,
    });
    expect(parseAiFeedProposal(badPagefeed)).toBeNull();

    const badFulltext = JSON.stringify({ mode: "fulltext", confidence: 0.5 });
    expect(parseAiFeedProposal(badFulltext)).toBeNull();

    const badMode = JSON.stringify({ mode: "something-else", confidence: 0.5 });
    expect(parseAiFeedProposal(badMode)).toBeNull();
  });
});

describe("proposeFeedConfig", () => {
  it("validates a good pagefeed proposal through the real engine", async () => {
    const result = await proposeFeedConfig("https://example.com/blog", AI_CONFIG, {
      fetchHtml: async () => BLOG_INDEX_HTML,
      runAi: async () => PAGEFEED_PROPOSAL_JSON,
    });

    expect(result.proposal.mode).toBe("pagefeed");
    expect(result.validation.ok).toBe(true);
    expect(result.validation.itemCount).toBe(5);
    expect(result.validation.sampleTitles?.some((t) => t.includes("Lighthouses"))).toBe(true);
    expect(result.validation.sampleTitles?.some((t) => t.includes("Fresnel"))).toBe(true);
  });

  it("validates a good fulltext proposal through the real engine", async () => {
    const result = await proposeFeedConfig("https://example.com/article", AI_CONFIG, {
      fetchHtml: async () => ARTICLE_HTML,
      runAi: async () => FULLTEXT_PROPOSAL_JSON,
    });

    expect(result.proposal.mode).toBe("fulltext");
    expect(result.validation.ok).toBe(true);
    expect(result.validation.extractedTextLength).toBeGreaterThan(400);
  });

  it("throws an 'unreadable config' error when the AI returns garbage", async () => {
    await expect(
      proposeFeedConfig("https://example.com/blog", AI_CONFIG, {
        fetchHtml: async () => BLOG_INDEX_HTML,
        runAi: async () => "I'm not going to give you JSON today.",
      }),
    ).rejects.toThrow("The AI returned an unreadable config");
  });

  it("marks validation as failed when the AI's selectors match nothing", async () => {
    const badProposal: AiFeedProposal = {
      mode: "pagefeed",
      itemConfig: { xPathItem: "//div[@class='does-not-exist-anywhere']" },
      confidence: 0.7,
    };

    const result = await proposeFeedConfig("https://example.com/blog", AI_CONFIG, {
      fetchHtml: async () => BLOG_INDEX_HTML,
      runAi: async () => JSON.stringify(badProposal),
    });

    expect(result.validation.ok).toBe(false);
  });
});
