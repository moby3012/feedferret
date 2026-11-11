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

const server = http.createServer((req, res) => {
  const url = new URL(req.url ?? "/", baseUrl);
  if (url.pathname === "/healthz") {
    res.writeHead(200, { "content-type": "text/plain" }).end("ok");
    return;
  }
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
  if (handleGoogleNews(req, res, url)) return;
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
