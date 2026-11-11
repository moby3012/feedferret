import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { buildPageDigest, PAGE_DIGEST_MAX_CHARS } from "../../lib/page-digest";
import { buildFeedConfigPrompt, reduceHtmlForPrompt } from "../../lib/ai-feed-config";

const fixture = (name: string) => readFileSync(path.join(__dirname, "../fixtures/web", name, "page.html"), "utf8");
const URL_ = "https://www.chronik.example/";

describe("buildPageDigest (chromie-like page: 27 KB head, feed anchors at ~188 KB)", () => {
  const html = fixture("chromie-like");
  const digest = buildPageDigest(html, URL_);

  it("stays within the budget", () => {
    expect(digest.length).toBeLessThanOrEqual(PAGE_DIGEST_MAX_CHARS);
  });

  it("carries page facts, not head noise", () => {
    expect(digest).toContain("Title: Spielwelt Chronik – News, Guides und Termine");
    expect(digest).toContain("Description: Deutscher Fan-Hub");
    expect(digest).toContain("Language: de");
    expect(digest).toContain("JSON-LD types: WebSite");
    expect(digest).not.toMatch(/preload|_next\/static|\.u12\{/);
  });

  it("lists the feed links found anywhere in the page", () => {
    expect(digest).toContain("- https://www.chronik.example/feed.xml (");
    expect(digest).toContain("https://www.chronik.example/feed.xml?zeitlinie=retail");
  });

  it("shows the main content's repeating items with link/title samples, collapsed", () => {
    expect(digest).toContain("[main content]");
    expect(digest).toMatch(/article\.news-card[^\n]*\n[\s\S]*"Patch-Notizen zur neuen Saison"/);
    expect(digest).toContain("→ /news/patch-notizen-zur-neuen-saison");
    expect(digest).toMatch(/… ×10 more article\.news-card/);
    expect(digest).toContain("Headings:\n- h1 Neueste News");
  });

  it("includes the heuristic's list candidates with sample items", () => {
    expect(digest).toMatch(/Repeating lists found by the built-in heuristic[\s\S]*xPathItem \/\/[^\n]*— 12 items/);
  });

  it("the old head-prefix input never reached the body; the AI prompt now does", async () => {
    // Regression guard against R3: the prompt must contain body content and the feed link.
    const prompt = await buildFeedConfigPrompt(html, URL_);
    expect(prompt).toContain("Patch-Notizen zur neuen Saison");
    expect(prompt).toContain("https://www.chronik.example/feed.xml");
    expect(prompt).toContain("<page-digest>");
    expect(prompt.length).toBeLessThan(PAGE_DIGEST_MAX_CHARS + 3_000);
  });

  it("is deterministic", () => {
    expect(buildPageDigest(html, URL_)).toBe(digest);
  });

  it("degrades gracefully on garbage and tiny budgets", () => {
    expect(buildPageDigest("", "https://e.example/")).toContain("URL: https://e.example/");
    const small = buildPageDigest(html, URL_, { maxChars: 600, includeCandidates: false });
    expect(small.length).toBeLessThanOrEqual(600);
  });
});

describe("reduceHtmlForPrompt (AI article extraction input)", () => {
  it("drops <head> and starts at the main content", () => {
    const html = `<html><head>${'<link rel="preload" href="/x.woff2">'.repeat(500)}</head><body><nav>menu</nav><main><article><h1>Title</h1><p>Body text here.</p></article></main></body></html>`;
    const reduced = reduceHtmlForPrompt(html);
    expect(reduced.startsWith("<main>")).toBe(true);
    expect(reduced).toContain("Body text here.");
    expect(reduced).not.toContain("preload");
  });

  it("does not depend on wall-clock time (the CI equivalence failure of #281: worker vs in-process diverged under load)", () => {
    const html = fixture("chromie-like");
    const reference = buildPageDigest(html, URL_);
    // A clock that jumps 10 s per reading exhausts any time budget at once.
    let t = 0;
    const spy = vi.spyOn(Date, "now").mockImplementation(() => (t += 10_000));
    try {
      expect(buildPageDigest(html, URL_)).toBe(reference);
    } finally {
      spy.mockRestore();
    }
  });
});
