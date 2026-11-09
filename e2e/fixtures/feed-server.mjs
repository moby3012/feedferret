// Tiny local HTTP server exposing the fixture feeds as RSS/Atom. No internet.
// Note: FeedFerret's SSRF guard blocks localhost, so the app cannot fetch
// these; articles are seeded straight into the DB (scripts/e2e-seed.mjs).
// This server exists so feed URLs in the DB point at a real, parseable
// endpoint (useful for manual poking and for tests that don't sync).
import http from "node:http";
import { FEEDS, FIXTURE_PORT, buildArticles, renderFeedXml } from "./data.mjs";

const baseUrl = `http://127.0.0.1:${FIXTURE_PORT}`;
const articles = buildArticles(Date.now());

const server = http.createServer((req, res) => {
  const url = new URL(req.url ?? "/", baseUrl);
  if (url.pathname === "/healthz") {
    res.writeHead(200, { "content-type": "text/plain" }).end("ok");
    return;
  }
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
