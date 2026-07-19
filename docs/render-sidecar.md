# Browser-render sidecar (M7-T2)

Some pages are genuinely **client-only**: the article or the post list is drawn
by JavaScript in the browser and never appears in the static HTML. FeedFerret's
in-process tiers (browser-fingerprint fetch, ftr-site-config rules, JSON-LD
recovery, the page→feed heuristic) can't reach that content because there is
nothing in the fetched HTML to extract.

Rather than bundle a headless browser into the default image — ~400–500 MB of
Chromium shipped to **every** deployment, running an untrusted-page browser
inside the reader's own container — FeedFerret can call out to an **optional,
admin-configured sidecar** that renders the page and returns HTML. If you don't
configure one, the feature is simply absent (the setting is hidden). This is the
same connector shape RSSHub / changedetection.io integrations use.

## What it improves

When configured, the sidecar is used as a **fallback** — only after the
in-process path comes up empty — on two flows:

- **Full-text extraction** (`Fetch full text` / auto full-text): if the direct
  fetch yields no readable content (or is blocked outright), the page is
  rendered via the sidecar and re-extracted.
- **Create feed from a web page** (page→feed builder): if the static HTML has no
  detectable item list (client-only blog index / forum), the rendered DOM is
  re-run through the candidate heuristic.

It does **not** magically defeat active anti-bot challenges (Cloudflare
Turnstile, DataDome) or IP-reputation blocks — that's the BYOK hosted tier
(M7-T3). This tier is for *rendering*, not *evasion*.

## The contract

The sidecar is any HTTP service that:

- accepts `POST <configured URL>` with a JSON body `{ "url": "<target>" }`
- (optionally) requires `Authorization: Bearer <token>`
- responds with the rendered document, either as:
  - `Content-Type: text/html` — the HTML document itself, **or**
  - `Content-Type: application/json` — an object (or crawl4ai-style
    `results[0]` / `result`) containing one of `html`, `content`,
    `cleaned_html`, or `markdown` (checked in that order).

That's deliberately minimal so both a self-hosted **crawl4ai** and a tiny
bespoke Playwright service satisfy it.

## Setup

**Wired up by default in `docker-compose.yaml`.** The repo's top-level compose
file already defines a `render-sidecar` service (built from
[`docker/render-sidecar/`](../docker/render-sidecar/): Dockerfile + tiny
Playwright service) and points `feedferret` at it via
`FEEDFERRET_RENDER_SIDECAR_URL=http://render-sidecar:8080/`. Both services share
one `RENDER_SIDECAR_TOKEN` env var, so a fresh `docker compose up -d` (or a
Coolify deploy of this repo) gives you a **working, already-active** sidecar
with no admin-UI step required — only change `RENDER_SIDECAR_TOKEN` from its
`change-me` default before deploying publicly.

**ENV always wins over the admin-UI/database config** (by design — see
`getRenderSidecarConfig` in `lib/render-sidecar.ts` — the same pattern used
elsewhere for immutable/container deployments). So with the bundled compose
file: the **Server Management → Sync → Browser-render sidecar** toggle and its
URL/token fields have **no effect** — the sidecar is active purely because the
ENV vars are set, and those fields will read back empty (they reflect the
database row, which nothing is writing to). To sanity-check connectivity
anyway, paste the same URL/token into those fields and click **Test** — that
exercises the identical endpoint the ENV config points at, it just doesn't
change what's actually used at runtime.

To turn the bundled sidecar **off**, remove the `FEEDFERRET_RENDER_SIDECAR_URL`
line (and the `render-sidecar` service, to stop building/running it) from
`docker-compose.yaml` — every call site already falls back gracefully when
it's absent or unreachable. Once ENV is unset, the admin-UI toggle and its
copy-paste "Setup guide" become the live configuration path instead, for a
*standalone* sidecar (a different host, a hand-edited compose file, etc.).

Or, for a hand-rolled deployment outside this repo's compose file, configure
any service implementing the contract below via environment:

```
FEEDFERRET_RENDER_SIDECAR_URL="http://render:8080/render"
FEEDFERRET_RENDER_SIDECAR_TOKEN="optional-shared-secret"
# Hard kill-switch regardless of DB/env config:
# FEEDFERRET_DISABLE_RENDER_SIDECAR="1"
```

ENV takes precedence over the admin-UI values.

### Example: crawl4ai

Run the official image and point the Sidecar URL at its crawl endpoint:

```yaml
# docker-compose.yml (excerpt)
services:
  crawl4ai:
    image: unclecode/crawl4ai:latest
    restart: unless-stopped
```

Sidecar URL: `http://crawl4ai:11235/crawl` (crawl4ai returns JSON with an
`html`/`cleaned_html` field, which the connector reads directly).

### Example: a lean Playwright service

A ~30-line service is enough. It only needs to render and return HTML:

```js
// render-sidecar.mjs  (node + playwright)
import http from "node:http";
import { chromium } from "playwright";

const TOKEN = process.env.SIDECAR_TOKEN || "";
const browser = await chromium.launch({ args: ["--no-sandbox"] });

http
  .createServer(async (req, res) => {
    if (req.method !== "POST") return res.writeHead(405).end();
    if (TOKEN && req.headers.authorization !== `Bearer ${TOKEN}`) return res.writeHead(401).end();

    let raw = "";
    for await (const chunk of req) raw += chunk;
    let url;
    try {
      url = new URL(JSON.parse(raw).url).toString();
    } catch {
      return res.writeHead(400).end();
    }

    const context = await browser.newContext();
    try {
      const page = await context.newPage();
      await page.goto(url, { waitUntil: "networkidle", timeout: 30_000 });
      const html = await page.content();
      res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ html }));
    } catch {
      res.writeHead(502).end();
    } finally {
      await context.close();
    }
  })
  .listen(8080, () => console.log("render sidecar on :8080"));
```

Sidecar URL: `http://render:8080/` with `FEEDFERRET_RENDER_SIDECAR_TOKEN` matching
`SIDECAR_TOKEN`.

## Security

- The **target URL** FeedFerret asks the sidecar to render is validated through
  the **same SSRF policy** as a direct fetch (private-IP / localhost blocked
  unless "Trusted internal feed URLs" is on), so the sidecar can't be used as an
  SSRF bypass for a malicious feed URL.
- The **sidecar base URL** is admin-configured and therefore trusted; it may be
  an internal host (that's the point). The bearer token is **encrypted at rest**.
- Content sent to the sidecar leaves the FeedFerret process but stays on
  infrastructure **you** run — nothing goes to a third party. (That trade-off is
  only made at the BYOK hosted tier, M7-T3, which is labelled accordingly.)
- The sidecar renders untrusted pages; run it isolated (its own container, no
  privileged mounts) so a render crash/OOM/exploit stays contained there and
  never touches the reader.
