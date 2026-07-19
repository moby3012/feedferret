// Minimal browser-render sidecar for FeedFerret (M7-T2).
//
// Implements FeedFerret's render contract exactly:
//   POST /            body: { "url": "<target>" }   [Authorization: Bearer <token>]
//   200  application/json  { "html": "<rendered document>" }
//
// It renders the target URL in a real headless Chromium (so client-only /
// JavaScript-drawn pages produce usable HTML) and returns the DOM. FeedFerret
// then runs its normal extraction / page→feed heuristics on the result.
//
// Run it isolated (its own container, no privileged mounts): it renders
// untrusted pages, so a crash/OOM/exploit must stay contained here.

import http from "node:http";
import { chromium } from "playwright";

// Deliberately NOT reading the generic `PORT` env var: PaaS platforms that
// deploy a whole Docker Compose stack (Coolify included) commonly inject
// environment variables at the project/resource level rather than
// per-service, so a `PORT` value meant for the main app can silently land on
// every container in the stack — this sidecar would then listen on the
// app's port instead of 8080, and the admin-configured Sidecar URL (:8080)
// would find nothing there. `SIDECAR_PORT` is a name nothing else defines.
const PORT = Number(process.env.SIDECAR_PORT || 8080);
const TOKEN = process.env.SIDECAR_TOKEN || "";
const NAV_TIMEOUT_MS = Number(process.env.NAV_TIMEOUT_MS || 30_000);
const MAX_BODY_BYTES = 8 * 1024; // request bodies are tiny ({ "url": … })

// One long-lived browser; a fresh isolated context per request.
const browser = await chromium.launch({ args: ["--no-sandbox", "--disable-dev-shm-usage"] });

function readBody(req) {
  return new Promise((resolve, reject) => {
    let raw = "";
    req.on("data", (chunk) => {
      raw += chunk;
      if (raw.length > MAX_BODY_BYTES) {
        reject(new Error("body too large"));
        req.destroy();
      }
    });
    req.on("end", () => resolve(raw));
    req.on("error", reject);
  });
}

const server = http.createServer(async (req, res) => {
  // Simple health check for `docker compose` / uptime probes.
  if (req.method === "GET" && (req.url === "/health" || req.url === "/healthz")) {
    return res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ ok: true }));
  }
  if (req.method !== "POST") {
    return res.writeHead(405, { allow: "POST" }).end();
  }
  if (TOKEN && req.headers.authorization !== `Bearer ${TOKEN}`) {
    return res.writeHead(401).end();
  }

  let target;
  try {
    const parsed = JSON.parse(await readBody(req));
    target = new URL(parsed.url).toString();
    if (!/^https?:$/.test(new URL(target).protocol)) throw new Error("bad scheme");
  } catch {
    return res.writeHead(400, { "content-type": "application/json" }).end(JSON.stringify({ error: "invalid url" }));
  }

  const context = await browser.newContext({ userAgent: process.env.USER_AGENT || undefined });
  try {
    const page = await context.newPage();
    await page.goto(target, { waitUntil: "networkidle", timeout: NAV_TIMEOUT_MS });
    const html = await page.content();
    res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ html }));
  } catch (error) {
    res.writeHead(502, { "content-type": "application/json" }).end(JSON.stringify({ error: String(error?.message || error) }));
  } finally {
    await context.close().catch(() => {});
  }
});

server.listen(PORT, () => console.log(`FeedFerret render sidecar listening on :${PORT}`));

async function shutdown() {
  await browser.close().catch(() => {});
  server.close(() => process.exit(0));
}
process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);
