import { describe, it, expect } from "vitest";
import { suggestFeedCandidates } from "../../lib/page-feed-suggest";

const BLOG_INDEX = `
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

const SINGLE_ARTICLE = `
<!DOCTYPE html>
<html>
<head><title>One Article</title></head>
<body>
  <nav><a href="/">Home</a></nav>
  <article>
    <h1>A Standalone Article</h1>
    <p>This page has a single article and no repeating list of items to turn into a feed.</p>
    <p>It continues for a second paragraph, but there is still only one article here.</p>
  </article>
</body>
</html>`;

describe("suggestFeedCandidates", () => {
  it("proposes the repeating post list from a blog index, not the nav/footer", () => {
    const candidates = suggestFeedCandidates(BLOG_INDEX, "https://example.com/blog");
    expect(candidates.length).toBeGreaterThan(0);

    const top = candidates[0];
    // The five posts win, not the 4-link nav or the 3-link footer.
    expect(top.itemCount).toBe(5);
    expect(top.sampleTitles.some((t) => t.includes("Lighthouses"))).toBe(true);
    expect(top.sampleTitles.some((t) => t.includes("Fresnel"))).toBe(true);
    // Every parsed item has a resolved absolute link.
    expect(top.previewArticles.every((a) => a.link.startsWith("https://example.com/"))).toBe(true);
    // Nav/footer titles must not be the winning items.
    expect(top.sampleTitles.some((t) => t === "Home" || t === "Privacy")).toBe(false);
  });

  it("captures date, image, and content field selectors when present", () => {
    const top = suggestFeedCandidates(BLOG_INDEX, "https://example.com/blog")[0];
    expect(top.config.xPathItem).toBeTruthy();
    expect(top.config.xPathItemUri).toBeTruthy();
    expect(top.config.xPathItemTitle).toBeTruthy();
    expect(top.config.xPathItemTimestamp).toBeTruthy();
    expect(top.config.xPathItemThumbnail).toBeTruthy();
    expect(top.config.xPathItemContent).toBeTruthy();
  });

  it("returns no candidate for a page with no repeating list", () => {
    const candidates = suggestFeedCandidates(SINGLE_ARTICLE, "https://example.com/article");
    // Either nothing at all, or nothing that reaches the 3-item repeat threshold.
    expect(candidates.every((c) => c.itemCount < 3)).toBe(true);
  });

  it("does not confidently propose repeating navigation/footer chrome as a candidate", () => {
    // Mirrors a real-world JS-rendered page: the actual content list is never
    // in the static HTML, leaving only repeating nav-style links behind. A
    // low-scoring candidate here is worse than no candidate at all, since it
    // misleads the user into thinking we found the real item list.
    const CHROME_ONLY = `
<!DOCTYPE html>
<html>
<head><title>App</title></head>
<body>
  <nav>
    <div class="nav-link"><a href="/solutions">Solutions</a></div>
    <div class="nav-link"><a href="/services">Services</a></div>
    <div class="nav-link"><a href="/tools">Tools</a></div>
    <div class="nav-link"><a href="/team">Team</a></div>
  </nav>
  <main><div id="app"></div></main>
</body>
</html>`;
    expect(suggestFeedCandidates(CHROME_ONLY, "https://example.com")).toEqual([]);
  });

  it("does not throw on junk input and returns an array", () => {
    expect(Array.isArray(suggestFeedCandidates("<html></html>", "https://example.com"))).toBe(true);
    expect(Array.isArray(suggestFeedCandidates("", "https://example.com"))).toBe(true);
  });

  it("still yields a candidate when the shared class token contains an apostrophe", () => {
    const APOSTROPHE_CLASS_INDEX = `
<!DOCTYPE html>
<html>
<head><title>Editor's Blog</title></head>
<body>
  <main>
    <div class="posts">
      <article class="it's-featured">
        <h2><a href="/posts/first-post">The First Post About Lighthouses</a></h2>
        <p>Lighthouses have guided sailors safely to shore for centuries, and this post explores their history.</p>
      </article>
      <article class="it's-featured">
        <h2><a href="/posts/second-post">Second Post: Fresnel Lenses Explained</a></h2>
        <p>The Fresnel lens revolutionized how far a lighthouse beam could travel across open water at night.</p>
      </article>
      <article class="it's-featured">
        <h2><a href="/posts/third-post">Third Post: Keepers and Their Lives</a></h2>
        <p>Lighthouse keepers led isolated lives, tending the light through storms and long lonely winters.</p>
      </article>
    </div>
  </main>
</body>
</html>`;

    const candidates = suggestFeedCandidates(APOSTROPHE_CLASS_INDEX, "https://example.com/blog");
    expect(candidates.length).toBeGreaterThan(0);
    expect(candidates[0].itemCount).toBe(3);
  });
});
