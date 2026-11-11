// Tiny local HTTP server exposing the fixture feeds as RSS/Atom. No internet.
// Note: FeedFerret's SSRF guard blocks localhost, so the app cannot fetch
// these; articles are seeded straight into the DB (scripts/e2e-seed.mjs).
// This server exists so feed URLs in the DB point at a real, parseable
// endpoint (useful for manual poking and for tests that don't sync).
import http from "node:http";
import { FEEDS, FIXTURE_PORT, buildArticles, renderFeedXml } from "./data.mjs";

const baseUrl = `http://127.0.0.1:${FIXTURE_PORT}`;
const articles = buildArticles(Date.now());

// --- Fake Google News (G1) --------------------------------------------------
// The app's Google News origin is pointed here in e2e
// (FEEDFERRET_GOOGLE_NEWS_BASE_URL), so the keyword-feed flow — search RSS,
// article splash page and the batchexecute link-decoding RPC — runs offline.
// Shapes mirror recordings from the live service (tests/fixtures/google-news).
const gnId = (query, n) => `CBMi${Buffer.from(`${query}|${n}`).toString("base64url")}xx`;
const xmlEscape = (v) => String(v).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
const GN_SOURCES = ["Tagesschau", "Heise online", "Der Spiegel"];

function handleGoogleNews(req, res, url) {
  if (url.pathname === "/rss/search") {
    const q = (url.searchParams.get("q") || "").replace(/\s+when:\w+$/, "");
    const empty = /nichts|nothing/i.test(q);
    const now = Date.now();
    const items = empty ? [] : GN_SOURCES.map((source, n) => {
      const id = gnId(q, n);
      const link = `${baseUrl}/rss/articles/${id}?oc=5`;
      return `<item><title>${xmlEscape(`${q}: Meldung ${n + 1} - ${source}`)}</title><link>${link}</link><guid isPermaLink="false">${id}</guid><pubDate>${new Date(now - n * 3600_000).toUTCString()}</pubDate><description>${xmlEscape(`<a href="${link}">${q}: Meldung ${n + 1}</a>&nbsp;&nbsp;<font color="#6f6f6f">${source}</font>`)}</description><source url="https://${source.toLowerCase().replace(/[^a-z]/g, "")}.example">${source}</source></item>`;
    });
    res.writeHead(200, { "content-type": "application/rss+xml; charset=utf-8" }).end(
      `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><rss version="2.0" xmlns:media="http://search.yahoo.com/mrss/"><channel><generator>NFE/5.0</generator><title>${xmlEscape(`"${q}" - Google News`)}</title><link>${baseUrl}/search?q=${encodeURIComponent(q)}</link><language>de</language><description>Google News</description>${items.join("")}</channel></rss>`,
    );
    return true;
  }
  const article = /^\/rss\/articles\/([A-Za-z0-9_-]+)$/.exec(url.pathname);
  if (article) {
    res.writeHead(200, { "content-type": "text/html; charset=utf-8" }).end(
      `<!doctype html><html><body><c-wiz><div jscontroller="aLI87" data-n-a-id="${article[1]}" data-n-a-ts="1794350423" data-n-a-sg="AdwtSYfixture${article[1].slice(-6)}" data-n-dnlg="false"></div></c-wiz></body></html>`,
    );
    return true;
  }
  if (url.pathname === "/_/DotsSplashUi/data/batchexecute" && req.method === "POST") {
    let body = "";
    req.on("data", (chunk) => (body += chunk));
    req.on("end", () => {
      const fReq = new URLSearchParams(body).get("f.req") || "[[]]";
      const envelopes = JSON.parse(fReq)[0];
      const rows = envelopes.map((env) => {
        const [, , id] = JSON.parse(env[1]);
        const [query, n] = Buffer.from(String(id).slice(4, -2), "base64url").toString("utf8").split("|");
        const publisher = `https://news-publisher.example/${encodeURIComponent(query.toLowerCase().replace(/\s+/g, "-"))}/meldung-${Number(n) + 1}`;
        return ["wrb.fr", "Fbv4je", JSON.stringify(["garturlres", publisher, 1]), null, null, null, env[3]];
      });
      res.writeHead(200, { "content-type": "application/json; charset=utf-8" }).end(`)]}'\n\n${JSON.stringify([...rows, ["di", 13]])}`);
    });
    return true;
  }
  return false;
}

// --- "Von Webseite" listing pages (selector quality gate) --------------------
// Fetched by the page → feed suggester only while a spec has explicitly
// enabled the admin "allow internal feed URLs" switch (127.0.0.1 is private).
const POSTS = [
  "Lighthouse keepers and their long winters",
  "How Fresnel lenses changed night navigation",
  "Automation arrives at the last manned stations",
  "Preservation societies rescue historic towers",
  "A field guide to coastal signal colours",
];
const slug = (title) => title.toLowerCase().replace(/[^a-z0-9]+/g, "-");
// "mixed": the real posts interleaved with three "Read more" promo cards.
function listingPage({ dated, mixed = false }) {
  const posts = POSTS.map((title, i) => {
    const date = dated ? `<time datetime="2026-11-0${i + 1}T09:00:00Z">Nov ${i + 1}, 2026</time>` : "";
    return `<article class="post"><h2><a href="/pages/posts/${slug(title)}">${title}</a></h2>${date}<p>${title} — a short teaser paragraph that gives the reader enough context to decide.</p></article>`;
  });
  if (mixed) {
    for (const [i, at] of [0, 2, 4].entries()) {
      posts.splice(at + i, 0, `<article class="post"><h2><a href="/pages/promo-${i}">Read more</a></h2><p>Sponsored placement in the middle of the list for testing.</p></article>`);
    }
  }
  const items = posts.join("");
  return `<!doctype html><html><head><title>Lighthouse log</title></head><body><nav><a href="/">Home</a><a href="/about">About</a><a href="/contact">Contact</a></nav><main><div class="posts">${items}</div></main></body></html>`;
}
const MENU_ONLY = `<!doctype html><html><head><title>App</title></head><body><main><div id="app"></div>
<ul class="promo-links">
<li class="promo-link"><a href="/login">Log in to your workspace now</a></li>
<li class="promo-link"><a href="/signup">Sign up for a free account today</a></li>
<li class="promo-link"><a href="https://www.instagram.com/example/">Follow the team on Instagram</a></li>
<li class="promo-link"><a href="https://www.bing.com/maps?where=Berlin">Visit our Berlin office location</a></li>
<li class="promo-link"><a href="/pricing">Read more</a></li>
</ul></main></body></html>`;

function handleListingPages(res, url) {
  const pages = {
    "/pages/undated": () => listingPage({ dated: false }),
    "/pages/dated": () => listingPage({ dated: true }),
    "/pages/mixed": () => listingPage({ dated: true, mixed: true }),
    "/pages/menu-only": () => MENU_ONLY,
  };
  const render = pages[url.pathname];
  if (!render) return false;
  res.writeHead(200, { "content-type": "text/html; charset=utf-8" }).end(render());
  return true;
}

// --- Discovery-first (add feed from a bare domain) -----------------------------
// A site whose only feed link is an RSS icon anchor deep in the footer, behind
// a large <head> — the owner's "bare domain + let AI set it up" case. Served
// over plain http, so a scheme-less input exercises the https → http retry.
const DISC_POSTS = ["Harbour lights at dusk", "Repairing an old foghorn", "Tide tables explained", "The keeper's logbook"];
function discoverySitePage() {
  const head = Array.from({ length: 120 }, (_, i) => `<link rel="preload" href="/_static/font-${i}.woff2" as="font">`).join("");
  const posts = DISC_POSTS.map((t) => `<article class="post"><h2><a href="/disc/site/posts/${slug(t)}">${t}</a></h2><time datetime="2026-11-01T09:00:00Z">Nov 1, 2026</time><p>${t} — teaser.</p></article>`).join("");
  return `<!doctype html><html><head><title>Harbour Notes</title>${head}</head><body><main><div class="posts">${posts}</div></main><footer><a href="/disc/site/about">About</a> <a href="/disc/site/feed.xml" aria-label="RSS feed"><svg viewBox="0 0 8 8"></svg></a></footer></body></html>`;
}
function handleDiscoverySite(res, url) {
  if (url.pathname === "/disc/site" || url.pathname === "/disc/site/") {
    res.writeHead(200, { "content-type": "text/html; charset=utf-8" }).end(discoverySitePage());
    return true;
  }
  if (url.pathname === "/disc/site/feed.xml") {
    const items = DISC_POSTS.map((t, i) => `<item><title>${t}</title><guid>disc-${i}</guid><link>${baseUrl}/disc/site/posts/${slug(t)}</link><description>${t}</description></item>`).join("");
    res.writeHead(200, { "content-type": "application/rss+xml" }).end(`<?xml version="1.0"?><rss version="2.0"><channel><title>Harbour Notes</title><link>${baseUrl}/disc/site/</link><description>Discovery fixture</description>${items}</channel></rss>`);
    return true;
  }
  return false;
}

// N1 PR D: newsletter reader. One-click unsubscribe endpoint (RFC 8058 POST)
// and a double-opt-in confirmation page; both record what reached them, so the
// spec can prove the POST body and that nothing is fetched before a click.
const newsletterHits = new Map();
function newsletterLog(id) {
  if (!newsletterHits.has(id)) newsletterHits.set(id, { posts: [], gets: [], confirms: 0 });
  return newsletterHits.get(id);
}
function handleNewsletter(req, res, url) {
  const unsub = /^\/newsletter\/unsubscribe\/([A-Za-z0-9_-]+)$/.exec(url.pathname);
  if (unsub) {
    const log = newsletterLog(unsub[1]);
    if (req.method === "POST") {
      let body = "";
      req.on("data", (chunk) => (body += chunk));
      req.on("end", () => {
        log.posts.push({ body, contentType: req.headers["content-type"] ?? null, cookie: req.headers.cookie ?? null });
        res.writeHead(200, { "content-type": "text/plain" }).end("unsubscribed");
      });
    } else {
      log.gets.push(url.search);
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" }).end("<!doctype html><title>Unsubscribe</title><p>Unsubscribe page</p>");
    }
    return true;
  }
  const confirm = /^\/newsletter\/confirm\/([A-Za-z0-9_-]+)$/.exec(url.pathname);
  if (confirm) {
    newsletterLog(confirm[1]).confirms += 1;
    res.writeHead(200, { "content-type": "text/html; charset=utf-8" }).end("<!doctype html><title>Confirmed</title><p>Subscription confirmed</p>");
    return true;
  }
  const hits = /^\/newsletter\/log\/([A-Za-z0-9_-]+)$/.exec(url.pathname);
  if (hits) {
    res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify(newsletterLog(hits[1])));
    return true;
  }
  return false;
}

// --- "Defekte Feeds" (broken-feeds triage spec) -------------------------------
// /broken/forbidden.xml  always 403 · /broken/missing.xml always 404
// /broken/flaky.xml      403 until GET /broken/heal (then a valid feed), reset by GET /broken/break
// /broken/moved/         a site page advertising /broken/moved/new.xml (the old feed URL 404s)
let brokenHealed = false;
const brokenRss = (title) =>
  `<?xml version="1.0"?><rss version="2.0"><channel><title>${title}</title><link>${baseUrl}</link><description>${title}</description><item><title>${title} item</title><guid>${title}-1</guid><link>${baseUrl}/broken/article</link><description>Recovered.</description></item></channel></rss>`;

function handleBrokenFeeds(res, url) {
  if (!url.pathname.startsWith("/broken/")) return false;
  const text = (status, body, type = "text/plain") => res.writeHead(status, { "content-type": type }).end(body);
  switch (url.pathname) {
    case "/broken/forbidden.xml":
      return text(403, "forbidden"), true;
    case "/broken/missing.xml":
    case "/broken/moved/old.xml":
      return text(404, "not found"), true;
    case "/broken/flaky.xml":
      return brokenHealed ? text(200, brokenRss("Flaky fixture"), "application/rss+xml") : text(403, "forbidden"), true;
    case "/broken/heal":
      brokenHealed = true;
      return text(200, "healed"), true;
    case "/broken/break":
      brokenHealed = false;
      return text(200, "broken"), true;
    case "/broken/moved/new.xml":
      return text(200, brokenRss("Moved fixture"), "application/rss+xml"), true;
    case "/broken/moved/":
      return text(
        200,
        `<!doctype html><html><head><title>Moved site</title><link rel="alternate" type="application/rss+xml" title="Moved fixture" href="/broken/moved/new.xml"></head><body><h1>Moved site</h1></body></html>`,
        "text/html; charset=utf-8",
      ), true;
    default:
      return false;
  }
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url ?? "/", baseUrl);
  if (url.pathname === "/healthz") {
    res.writeHead(200, { "content-type": "text/plain" }).end("ok");
    return;
  }
  if (url.pathname.startsWith("/newsletter/") && handleNewsletter(req, res, url)) return;
  if (url.pathname === "/h4/feed") {
    res.writeHead(200, { "content-type": "application/rss+xml" }).end(
      `<?xml version="1.0"?><rss version="2.0"><channel><title>H4 fixture</title><link>${baseUrl}</link><description>Offline transport fixture</description><item><title>H4 article</title><guid>h4-article</guid><link>${baseUrl}/h4/article</link><description>Short excerpt.</description></item></channel></rss>`,
    );
    return;
  }
  if (url.pathname === "/h4/article") {
    const paragraph = "This offline article explains how a DNS answer is checked inside the connection lookup. The same address is then used by the socket, preventing a second resolution from reaching a private service. ";
    res.writeHead(200, { "content-type": "text/html" }).end(
      `<!doctype html><html><head><title>H4 article</title></head><body><main><article><h1>H4 article</h1>${Array.from({ length: 12 }, () => `<p>${paragraph.repeat(3)}</p>`).join("")}</article></main></body></html>`,
    );
    return;
  }
  // M8: a feed behind HTTP Basic auth (credentials are stored encrypted in the app).
  if (url.pathname === "/auth/feed.xml") {
    const expected = `Basic ${Buffer.from("e2e-feed-user:e2e:feed-pass").toString("base64")}`;
    if (req.headers.authorization !== expected) {
      res.writeHead(401, { "www-authenticate": 'Basic realm="e2e"', "content-type": "text/plain" }).end("unauthorized");
      return;
    }
    res.writeHead(200, { "content-type": "application/rss+xml" }).end(
      `<?xml version="1.0"?><rss version="2.0"><channel><title>Auth fixture</title><link>${baseUrl}</link><description>Basic auth fixture</description><item><title>Behind basic auth</title><guid>auth-article</guid><link>${baseUrl}/auth/article</link><description>Only with credentials.</description></item></channel></rss>`,
    );
    return;
  }
  if (handleBrokenFeeds(res, url)) return;
  if (handleGoogleNews(req, res, url)) return;
  if (handleListingPages(res, url)) return;
  if (handleDiscoverySite(res, url)) return;
  const m = /^\/feeds\/([a-z0-9-]+)\.xml$/.exec(url.pathname);
  const feed = m && FEEDS.find((f) => f.slug === m[1]);
  if (!feed) {
    res.writeHead(404, { "content-type": "text/plain" }).end("not found");
    return;
  }
  res
    .writeHead(200, { "content-type": feed.format === "atom" ? "application/atom+xml" : "application/rss+xml" })
    .end(renderFeedXml(feed, articles, baseUrl));
});

server.listen(FIXTURE_PORT, "127.0.0.1", () => {
  console.log(`[fixture-feeds] listening on ${baseUrl}`);
});
for (const sig of ["SIGINT", "SIGTERM"]) process.on(sig, () => server.close(() => process.exit(0)));
