# FeedFerret render sidecar

A minimal, self-contained browser-render service for FeedFerret's optional
**browser-render sidecar** feature (M7-T2). It renders JavaScript-heavy /
client-only pages in a real headless Chromium and returns the HTML, which
FeedFerret uses as a fallback for full-text extraction and the
"Create feed from a web page" builder when its in-process fetch finds nothing.

See the top-level [`docs/render-sidecar.md`](../../docs/render-sidecar.md) for
the full contract, security notes, and alternatives (e.g. crawl4ai).

## Quick start (Docker)

```bash
# from the repo root
docker build -t feedferret-render-sidecar ./docker/render-sidecar
docker run --rm -p 8080:8080 -e SIDECAR_TOKEN=change-me feedferret-render-sidecar
```

Or use [`docker-compose.example.yml`](./docker-compose.example.yml) to run it
alongside FeedFerret on the same network.

Then in FeedFerret: **Server Management → Sync → Browser-render sidecar** →
enable, set the URL (`http://render-sidecar:8080/` on a shared Docker network,
or `http://localhost:8080/` for the local run above), paste the token if you set
one, and click **Test**.

## Contract

```
POST /            { "url": "https://example.com/page" }     [Authorization: Bearer <token>]
→ 200 application/json   { "html": "<rendered document>" }

GET  /health      → 200 { "ok": true }
```

## Environment

| Variable | Default | Meaning |
|---|---|---|
| `PORT` | `8080` | Listen port |
| `SIDECAR_TOKEN` | *(none)* | If set, requests must send `Authorization: Bearer <token>` |
| `NAV_TIMEOUT_MS` | `30000` | Per-page navigation timeout |
| `USER_AGENT` | *(Chromium default)* | Override the browser User-Agent |

## Notes

- It renders **untrusted** pages. Run it isolated (its own container, no
  privileged mounts, not exposed to the public internet).
- Stateless — scale by running more replicas behind a load balancer if needed.
