// Deterministic E2E / perf dataset. Pure functions, no I/O, no network.
// Shared by scripts/e2e-seed.mjs (DB seeding), e2e/fixtures/feed-server.mjs
// (local RSS/Atom endpoints) and the specs (via the manifest the seed writes).

export const FIXTURE_PORT = Number(process.env.E2E_FIXTURE_PORT || 4010);
export const ARTICLE_COUNT = 300;
export const PASSWORD = "e2e-password-123";

export const USERS = [
  { key: "desktop", email: "e2e-desktop@feedferret.test", name: "E2E Desktop" },
  { key: "mobile", email: "e2e-mobile@feedferret.test", name: "E2E Mobile" },
  { key: "perf", email: "e2e-perf@feedferret.test", name: "E2E Perf" },
];

export const CATEGORIES = [
  { key: "tech", name: "Tech" },
  { key: "news", name: "News" },
  { key: "culture", name: "Culture" },
];

export const FEEDS = [
  { slug: "hacker-dispatch", name: "Hacker Dispatch", category: "tech", format: "rss" },
  { slug: "rust-weekly", name: "Rust Weekly Digest", category: "tech", format: "atom" },
  { slug: "frontend-focus", name: "Frontend Focus", category: "tech", format: "rss" },
  { slug: "world-wire", name: "World Wire", category: "news", format: "rss" },
  { slug: "local-ledger", name: "Local Ledger", category: "news", format: "atom" },
  { slug: "science-notes", name: "Science Notes", category: "news", format: "rss" },
  { slug: "film-and-fiction", name: "Film and Fiction", category: "culture", format: "rss" },
  { slug: "solo-blog", name: "Solo Blog", category: null, format: "rss" },
];

export const LABELS = [
  { key: "important", name: "Important", color: "#ef4444" },
  { key: "tutorial", name: "Tutorial", color: "#3b82f6" },
];

/** Search needle that appears in exactly SEARCH_NEEDLE_HITS article titles. */
export const SEARCH_NEEDLE = "quokka";

function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const TOPICS = [
  "caching strategies", "build pipelines", "type systems", "memory safety", "async runtimes",
  "design tokens", "accessibility audits", "edge functions", "database indexes", "release trains",
  "observability", "state machines", "offline sync", "service workers", "rendering budgets",
  "climate models", "city budgets", "festival lineups", "protein folding", "supply chains",
];
const VERBS = ["Rethinking", "Measuring", "Shipping", "Debugging", "Scaling", "Untangling", "Explaining", "Benchmarking"];
const WORDS = (
  "lorem ipsum dolor sit amet consectetur adipiscing elit sed do eiusmod tempor incididunt ut labore et dolore magna " +
  "aliqua enim minim veniam quis nostrud exercitation ullamco laboris nisi aliquip commodo consequat duis aute irure " +
  "reprehenderit voluptate velit esse cillum fugiat nulla pariatur excepteur sint occaecat cupidatat non proident"
).split(" ");

function sentence(rnd, n) {
  const out = [];
  for (let i = 0; i < n; i++) out.push(WORDS[Math.floor(rnd() * WORDS.length)]);
  const s = out.join(" ");
  return s.charAt(0).toUpperCase() + s.slice(1) + ".";
}
function paragraph(rnd, sentences = 4) {
  const parts = [];
  for (let i = 0; i < sentences; i++) parts.push(sentence(rnd, 8 + Math.floor(rnd() * 10)));
  return `<p>${parts.join(" ")}</p>`;
}

function svgDataUri(label, hue) {
  const svg =
    `<svg xmlns="http://www.w3.org/2000/svg" width="640" height="360" viewBox="0 0 640 360">` +
    `<rect width="640" height="360" fill="hsl(${hue},55%,45%)"/>` +
    `<text x="320" y="190" font-size="36" text-anchor="middle" fill="#fff" font-family="sans-serif">${label}</text></svg>`;
  return `data:image/svg+xml;base64,${Buffer.from(svg).toString("base64")}`;
}

const CODE = `function fibonacci(n: number): number {
  if (n < 2) return n;
  return fibonacci(n - 1) + fibonacci(n - 2);
}

export const memo = new Map<number, number>();
export function fast(n: number): number {
  if (memo.has(n)) return memo.get(n)!;
  const v = n < 2 ? n : fast(n - 1) + fast(n - 2);
  memo.set(n, v);
  return v;
}`;

/**
 * @param {number} now epoch ms the dataset is anchored to
 * @returns {{articles: Array<object>, unreadCount: number, ...}}
 */
export function buildArticles(now) {
  const articles = [];
  for (let i = 0; i < ARTICLE_COUNT; i++) {
    const rnd = mulberry32(1000 + i);
    const feed = FEEDS[i % FEEDS.length];
    const topic = TOPICS[Math.floor(rnd() * TOPICS.length)];
    const verb = VERBS[Math.floor(rnd() * VERBS.length)];
    const isLong = i % 10 === 4;
    const hasImage = i % 7 === 2;
    const hasCode = i % 9 === 5;
    const needle = i % 100 === 17; // 3 hits: 17, 117, 217
    const n = String(i + 1).padStart(3, "0");
    const title = `${verb} ${topic}${needle ? ` with a ${SEARCH_NEEDLE}` : ""} (#${n})`;

    const parts = [];
    if (hasImage) {
      parts.push(`<figure><img src="${svgDataUri(`Figure ${n}`, (i * 37) % 360)}" alt="Figure ${n}" width="640" height="360"><figcaption>Figure ${n}: generated fixture image</figcaption></figure>`);
    }
    const paragraphs = isLong ? 40 : 3;
    for (let p = 0; p < paragraphs; p++) {
      parts.push(paragraph(rnd, 4));
      if (hasCode && p === 1) parts.push(`<pre><code class="language-ts">${CODE}</code></pre>`);
      if (isLong && p % 8 === 3) parts.push(`<h2>Section ${p / 8 + 1}</h2>`);
    }
    if (needle) parts.push(`<p>The ${SEARCH_NEEDLE} is a small marsupial.</p>`);
    const content = parts.join("\n");
    const excerpt = content.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim().slice(0, 180);

    // Flags. Newest 12 articles are always unread so "open first article" is stable.
    const isRead = i >= 12 && i % 5 < 2;
    const isStarred = i % 23 === 3;
    const isReadLater = i % 31 === 5;
    const labels = [];
    if (i % 11 === 0) labels.push("important");
    if (i % 13 === 2) labels.push("tutorial");

    articles.push({
      index: i,
      guid: `urn:feedferret:e2e:${i}`,
      feedSlug: feed.slug,
      title,
      link: `https://fixtures.feedferret.test/${feed.slug}/${n}`,
      author: `Author ${(i % 5) + 1}`,
      publishedAt: new Date(now - i * 45 * 60 * 1000),
      content,
      excerpt,
      imageUrl: hasImage ? svgDataUri(`Cover ${n}`, (i * 37) % 360) : null,
      isRead,
      isStarred,
      isReadLater,
      labels,
      traits: { isLong, hasImage, hasCode, needle },
    });
  }
  return articles;
}

export function escapeXml(s) {
  return String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

/** Render a feed's fixture articles as RSS 2.0 or Atom 1.0 (first 25 articles). */
export function renderFeedXml(feed, articles, baseUrl) {
  const items = articles.filter((a) => a.feedSlug === feed.slug).slice(0, 25);
  if (feed.format === "atom") {
    return `<?xml version="1.0" encoding="utf-8"?>
<feed xmlns="http://www.w3.org/2005/Atom">
  <title>${escapeXml(feed.name)}</title>
  <id>${baseUrl}/feeds/${feed.slug}.xml</id>
  <updated>${items[0].publishedAt.toISOString()}</updated>
  <link href="${baseUrl}/feeds/${feed.slug}.xml" rel="self"/>
${items.map((a) => `  <entry>
    <title>${escapeXml(a.title)}</title>
    <id>${a.guid}</id>
    <link href="${a.link}"/>
    <updated>${a.publishedAt.toISOString()}</updated>
    <author><name>${escapeXml(a.author)}</name></author>
    <content type="html">${escapeXml(a.content)}</content>
  </entry>`).join("\n")}
</feed>
`;
  }
  return `<?xml version="1.0" encoding="utf-8"?>
<rss version="2.0">
  <channel>
    <title>${escapeXml(feed.name)}</title>
    <link>https://fixtures.feedferret.test/${feed.slug}</link>
    <description>Fixture feed ${escapeXml(feed.name)}</description>
${items.map((a) => `    <item>
      <title>${escapeXml(a.title)}</title>
      <link>${a.link}</link>
      <guid isPermaLink="false">${a.guid}</guid>
      <pubDate>${a.publishedAt.toUTCString()}</pubDate>
      <author>${escapeXml(a.author)}</author>
      <description>${escapeXml(a.content)}</description>
    </item>`).join("\n")}
  </channel>
</rss>
`;
}
