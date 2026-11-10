#!/usr/bin/env node
// Lab performance baseline for FeedFerret (authenticated `/`, mobile profile).
//
//   pnpm run build && node scripts/perf-measure.mjs            # own server + seeded DB
//   node scripts/perf-measure.mjs --runs 5 --label before-d1
//   node scripts/perf-measure.mjs --base-url http://localhost:3000 --email a@b --password x
//
// Profile (matches .pm/audit-perf.md §4.1): Pixel-7 emulation at 390x844 with
// touch, CDP 4x CPU throttle, "Slow 4G" (1.6 Mbps down / 750 Kbps up / 150 ms
// RTT), service workers blocked, cold browser context (empty cache) per run.
// Login happens first in an UNthrottled context and is not measured; the
// session is then reused (the app is always measured "warm session, cold cache").
//
// Metrics: LCP, CLS, TBT (long tasks), time-to-first-article-row, requests and
// bytes at cold start, INP-proxy (Event Timing of open-article / mark-read /
// star taps) and first-load JS (gz) for `/` from the .next manifests.
//
// Output: perf-results/<label>.json + .md (gitignored); the markdown table is
// also printed and appended to $GITHUB_STEP_SUMMARY when set. Numbers are LAB
// numbers on whatever machine runs this: compare runs from the same machine /
// CI runner type, never across.
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import zlib from "node:zlib";
import { spawn, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import Database from "better-sqlite3";
import { chromium, devices } from "@playwright/test";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const args = process.argv.slice(2);
const opt = (name, fallback) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : fallback;
};
const RUNS = Number(opt("runs", 5));
const LABEL = opt("label", new Date().toISOString().slice(0, 10) + "-perf");
const OUT_DIR = path.resolve(root, opt("out", "perf-results"));
const PORT = Number(opt("port", 3200));
const EXTERNAL = opt("base-url");
const BASE = EXTERNAL ?? `http://localhost:${PORT}`;

const PROFILE = {
  device: "Pixel 7 (viewport 390x844, touch)",
  cpuThrottle: 4,
  network: { name: "Slow 4G", downKbps: 1600, upKbps: 750, rttMs: 150 },
};

// ---------------------------------------------------------------- server
let server;
let perfDb; // path of the seeded DB when we own the server (flag reset between runs)
let creds = { email: opt("email"), password: opt("password") };
async function startServer() {
  const dbPath = path.join(root, ".e2e", "perf", "perf.db");
  const env = {
    ...process.env,
    E2E_DB_PATH: dbPath,
    DATABASE_PROVIDER: "sqlite",
    DATABASE_URL: `file:${dbPath}`,
    AUTH_SECRET: "e2e-0123456789abcdef0123456789abcd-k",
    AUTH_URL: BASE,
    NEXTAUTH_URL: BASE,
    AUTH_TRUST_HOST: "true",
    DISABLE_BACKGROUND_SYNC: "true",
    NEXT_TELEMETRY_DISABLED: "1",
    NODE_ENV: "production",
  };
  const seed = spawnSync("node", ["scripts/e2e-seed.mjs"], { cwd: root, env, stdio: "inherit" });
  if (seed.status !== 0) throw new Error("seed failed");
  const manifest = JSON.parse(fs.readFileSync(path.join(root, ".e2e", "perf", "manifest.json"), "utf8"));
  creds = { email: manifest.users.perf.email, password: manifest.password };
  perfDb = { path: dbPath, userId: manifest.users.perf.userId };
  if (!fs.existsSync(path.join(root, ".next", "BUILD_ID"))) throw new Error("no production build: run `pnpm run build` first");
  server = spawn("npx", ["next", "start", "-p", String(PORT)], { cwd: root, env, stdio: ["ignore", "ignore", "inherit"] });
  for (let i = 0; i < 120; i++) {
    try {
      if ((await fetch(`${BASE}/login`)).ok) return;
    } catch { /* not up yet */ }
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error("server did not start");
}

// -------------------------------------------------------------- bundle size
function firstLoadJs() {
  const nextDir = path.join(root, ".next");
  const sandbox = {};
  sandbox.globalThis = sandbox;
  vm.runInNewContext(fs.readFileSync(path.join(nextDir, "server/app/page_client-reference-manifest.js"), "utf8"), sandbox);
  const entry = sandbox.__RSC_MANIFEST["/page"].entryJSFiles["[project]/app/page"];
  const build = JSON.parse(fs.readFileSync(path.join(nextDir, "build-manifest.json"), "utf8"));
  const size = (files) => {
    let raw = 0, gz = 0;
    for (const f of new Set(files)) {
      const buf = fs.readFileSync(path.join(nextDir, f));
      raw += buf.length;
      gz += zlib.gzipSync(buf).length;
    }
    return { files: new Set(files).size, rawKb: +(raw / 1024).toFixed(1), gzKb: +(gz / 1024).toFixed(1) };
  };
  return {
    // Same method as .pm/audit-perf.md §2.2 (route entry chunks incl. layout).
    pageEntry: size(entry),
    // Plus the framework/runtime chunks every page loads.
    withRuntime: size([...entry, ...build.rootMainFiles, ...build.polyfillFiles]),
  };
}

// ------------------------------------------------------------- measurement
const observers = () => {
  window.__perf = { lcp: 0, cls: 0, longTasks: [], events: [], firstRowAt: null };
  try {
    new PerformanceObserver((l) => { for (const e of l.getEntries()) window.__perf.lcp = e.startTime; })
      .observe({ type: "largest-contentful-paint", buffered: true });
    new PerformanceObserver((l) => { for (const e of l.getEntries()) if (!e.hadRecentInput) window.__perf.cls += e.value; })
      .observe({ type: "layout-shift", buffered: true });
    new PerformanceObserver((l) => { for (const e of l.getEntries()) window.__perf.longTasks.push([e.startTime, e.duration]); })
      .observe({ type: "longtask", buffered: true });
    new PerformanceObserver((l) => {
      for (const e of l.getEntries()) window.__perf.events.push({ name: e.name, start: e.startTime, duration: e.duration, interactionId: e.interactionId });
    }).observe({ type: "event", buffered: true, durationThreshold: 16 });
  } catch { /* unsupported entry type */ }
  const check = () => {
    if (window.__perf.firstRowAt == null && document.querySelector('[role="button"][aria-label*=" — "]')) {
      window.__perf.firstRowAt = performance.now();
      return true;
    }
    return false;
  };
  new MutationObserver((_, mo) => { if (check()) mo.disconnect(); }).observe(document, { childList: true, subtree: true });
};

const median = (xs) => {
  const s = xs.filter((x) => x != null && !Number.isNaN(x)).sort((a, b) => a - b);
  if (!s.length) return null;
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};

async function throttle(context, page) {
  const cdp = await context.newCDPSession(page);
  await cdp.send("Network.enable");
  await cdp.send("Network.emulateNetworkConditions", {
    offline: false,
    latency: PROFILE.network.rttMs,
    downloadThroughput: (PROFILE.network.downKbps * 1024) / 8,
    uploadThroughput: (PROFILE.network.upKbps * 1024) / 8,
  });
  await cdp.send("Emulation.setCPUThrottlingRate", { rate: PROFILE.cpuThrottle });
  return cdp;
}

/** Interaction latency from Event Timing: longest event with an interactionId since `since`. */
async function interactionMs(page, since) {
  await page.waitForTimeout(400);
  return page.evaluate((t) => {
    const evs = window.__perf.events.filter((e) => e.start >= t && e.interactionId > 0);
    return evs.length ? Math.max(...evs.map((e) => e.duration)) : null;
  }, since);
}

async function singleRun(browser, storageState) {
  const context = await browser.newContext({
    ...devices["Pixel 7"], viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true,
    locale: "en-US", timezoneId: "UTC", serviceWorkers: "block", storageState,
  });
  await context.addInitScript(() => { try { localStorage.setItem("feedferret:pwa-install-prompt-dismissed", "1"); } catch {} });
  await context.addInitScript(observers);
  const page = await context.newPage();
  const cdp = await throttle(context, page);

  let requests = 0, actionPosts = 0, apiCalls = 0, jsBytes = 0, totalBytes = 0;
  const urls = new Map();
  // Data responses that can carry the article list: Next-Action POSTs (the
  // pre-#PR1 `getArticles` server action) and GET /api/app/articles. The
  // largest one finished before the first row is the list payload.
  const dataReqs = new Set();
  const decoded = new Map();
  let listPayload = { encoded: 0, decoded: 0 };
  let coldDone = false;
  cdp.on("Network.requestWillBeSent", (e) => {
    requests++;
    urls.set(e.requestId, e.request.url);
    const isAction = !!(e.request.headers["next-action"] || e.request.headers["Next-Action"]);
    if (isAction) actionPosts++;
    const { pathname } = new URL(e.request.url);
    if (pathname.startsWith("/api/")) apiCalls++;
    if (isAction || /^\/api\/app\/articles\/?$/.test(pathname)) dataReqs.add(e.requestId);
  });
  cdp.on("Network.dataReceived", (e) => {
    if (dataReqs.has(e.requestId)) decoded.set(e.requestId, (decoded.get(e.requestId) ?? 0) + e.dataLength);
  });
  cdp.on("Network.loadingFinished", (e) => {
    totalBytes += e.encodedDataLength;
    if ((urls.get(e.requestId) ?? "").includes(".js")) jsBytes += e.encodedDataLength;
    if (!coldDone && dataReqs.has(e.requestId) && e.encodedDataLength > listPayload.encoded) {
      listPayload = { encoded: e.encodedDataLength, decoded: decoded.get(e.requestId) ?? 0 };
    }
  });

  await page.goto(`${BASE}/`, { waitUntil: "commit" });
  await page.waitForSelector('[role="button"][aria-label*=" — "]', { timeout: 120_000 });
  await page.waitForLoadState("networkidle").catch(() => {});
  await page.waitForTimeout(1500); // let LCP / late shifts settle
  const cold = await page.evaluate(() => {
    const p = window.__perf;
    return {
      lcp: p.lcp, cls: p.cls, firstRow: p.firstRowAt,
      tbt: p.longTasks.reduce((s, [, d]) => s + Math.max(0, d - 50), 0),
      longTasks: p.longTasks.length,
      fcp: performance.getEntriesByName("first-contentful-paint")[0]?.startTime ?? null,
    };
  });
  coldDone = true;
  const coldRequests = {
    requests, actionPosts, apiCalls, kbTransferred: +(totalBytes / 1024).toFixed(1), jsKbTransferred: +(jsBytes / 1024).toFixed(1),
    listPayloadKb: +(listPayload.encoded / 1024).toFixed(1), listPayloadRawKb: +(listPayload.decoded / 1024).toFixed(1),
  };

  // ---- interactions (INP proxy) ----
  const now = () => page.evaluate(() => performance.now());
  const rows = page.locator('[role="button"][aria-label^="Unread:"]');

  let t = await now();
  await page.locator('[role="button"][aria-label^="Unread:"]').first().tap();
  const openMs = await interactionMs(page, t);
  // time until the reader's title is painted
  const readerMs = await page.evaluate(async (t0) => {
    const until = performance.now() + 5000;
    while (!document.querySelector("article h1") && performance.now() < until) await new Promise((r) => requestAnimationFrame(r));
    return performance.now() - t0;
  }, t);
  // ... and until the article body is painted (on-demand detail fetch since PR 1).
  const readerBodyMs = await page.evaluate(async (t0) => {
    const until = performance.now() + 10000;
    while (!document.querySelector("article .article-content") && performance.now() < until) await new Promise((r) => requestAnimationFrame(r));
    return performance.now() - t0;
  }, t);
  await page.getByRole("button", { name: /^(Back to list|Back)$/ }).first().tap();
  await page.waitForTimeout(600);

  t = await now();
  await rows.nth(1).getByRole("button", { name: "Mark as read" }).tap();
  const markReadMs = await interactionMs(page, t);

  t = await now();
  await rows.nth(1).getByRole("button", { name: "Star" }).tap();
  const starMs = await interactionMs(page, t);

  await context.close();
  return { ...cold, ...coldRequests, openArticleInp: openMs, openArticleToReaderMs: readerMs, openArticleToBodyMs: readerBodyMs, markReadInp: markReadMs, starInp: starMs };
}

/** Restore seeded read/star flags so every run opens/marks the same unread rows. */
function resetFlags() {
  if (!perfDb) return;
  const db = new Database(perfDb.path);
  try {
    db.pragma("busy_timeout = 5000");
    db.prepare(
      `UPDATE "Article" SET
         isRead = (SELECT isRead FROM e2e_pristine WHERE articleId = "Article".id),
         readAt = (SELECT readAt FROM e2e_pristine WHERE articleId = "Article".id),
         isStarred = (SELECT isStarred FROM e2e_pristine WHERE articleId = "Article".id),
         isReadLater = (SELECT isReadLater FROM e2e_pristine WHERE articleId = "Article".id),
         readLaterSavedAt = (SELECT readLaterSavedAt FROM e2e_pristine WHERE articleId = "Article".id)
       WHERE userId = ?`,
    ).run(perfDb.userId);
  } finally {
    db.close();
  }
}

// ------------------------------------------------------------------- main
function fmt(v, d = 0) { return v == null ? "n/a" : v.toFixed(d); }

async function main() {
  if (!EXTERNAL) await startServer();
  const jsSize = firstLoadJs();
  const browser = await chromium.launch();
  // Login once, unthrottled, not measured.
  const lctx = await browser.newContext({ locale: "en-US", serviceWorkers: "block" });
  const lp = await lctx.newPage();
  await lp.goto(`${BASE}/login`);
  await lp.getByPlaceholder("Email").fill(creds.email);
  await lp.getByPlaceholder("Password").fill(creds.password);
  await lp.locator('button[type="submit"]').click();
  await lp.waitForURL((u) => u.pathname === "/", { timeout: 60_000 });
  const storageState = await lctx.storageState();
  await lctx.close();

  const runs = [];
  for (let i = 0; i < RUNS; i++) {
    resetFlags();
    process.stdout.write(`run ${i + 1}/${RUNS} ... `);
    const r = await singleRun(browser, storageState);
    runs.push(r);
    console.log(`LCP ${fmt(r.lcp)} ms, first row ${fmt(r.firstRow)} ms, ${r.requests} requests`);
  }
  await browser.close();
  server?.kill("SIGTERM");

  const keys = Object.keys(runs[0]);
  const med = Object.fromEntries(keys.map((k) => [k, median(runs.map((r) => r[k]))]));
  const commit = spawnSync("git", ["rev-parse", "--short", "HEAD"], { cwd: root, encoding: "utf8" }).stdout.trim();
  const result = {
    label: LABEL, date: new Date().toISOString(), commit, node: process.version, platform: `${process.platform}/${process.arch}`,
    profile: PROFILE, runsCount: RUNS, median: med, runs, firstLoadJs: jsSize,
  };

  const md = [
    `### FeedFerret perf — ${LABEL}`,
    ``,
    `Commit \`${commit}\` · ${result.platform} · Node ${process.version} · ${RUNS} cold runs, median · ${PROFILE.device}, ${PROFILE.cpuThrottle}x CPU, ${PROFILE.network.name} (${PROFILE.network.downKbps / 1000} Mbps / ${PROFILE.network.rttMs} ms RTT) · seeded: 300 articles / 8 feeds`,
    ``,
    `| Metric | Median | Budget (audit §4.1) |`,
    `|---|---:|---|`,
    `| LCP | ${fmt(med.lcp)} ms | ≤ 2500 ms |`,
    `| FCP | ${fmt(med.fcp)} ms | |`,
    `| CLS | ${fmt(med.cls, 3)} | ≤ 0.05 |`,
    `| TBT (long tasks, cold load) | ${fmt(med.tbt)} ms (${fmt(med.longTasks)} tasks) | ≤ 300 ms |`,
    `| Time to first article row | ${fmt(med.firstRow)} ms | ≤ 2000 ms |`,
    `| Requests at cold start | ${fmt(med.requests)} (${fmt(med.actionPosts)} Next-Action POSTs, ${fmt(med.apiCalls)} /api) | ≤ 4 parallel data requests |`,
    `| Transferred at cold start | ${fmt(med.kbTransferred, 0)} KB (JS ${fmt(med.jsKbTransferred, 0)} KB) | |`,
    `| List payload (first list response) | ${fmt(med.listPayloadKb, 1)} KB transferred (${fmt(med.listPayloadRawKb, 1)} KB raw) | ≤ 100 KB gz / 50 rows |`,
    `| INP-proxy: open article (tap) | ${fmt(med.openArticleInp)} ms | ≤ 200 ms |`,
    `| Tap → reader title painted | ${fmt(med.openArticleToReaderMs)} ms | ≤ 100 ms (P1-09) |`,
    `| Tap → reader body painted | ${fmt(med.openArticleToBodyMs)} ms | |`,
    `| INP-proxy: mark read (tap) | ${fmt(med.markReadInp)} ms | ≤ 200 ms |`,
    `| INP-proxy: star (tap) | ${fmt(med.starInp)} ms | ≤ 200 ms |`,
    `| First-load JS \`/\` (gz), route entry | ${jsSize.pageEntry.gzKb} KB (${jsSize.pageEntry.rawKb} KB raw, ${jsSize.pageEntry.files} chunks) | ≤ 180 KB |`,
    `| First-load JS \`/\` (gz), incl. runtime | ${jsSize.withRuntime.gzKb} KB (${jsSize.withRuntime.rawKb} KB raw, ${jsSize.withRuntime.files} chunks) | |`,
    ``,
    `INP-proxy = longest Event Timing entry with an interactionId during the action (input → next paint, 8 ms granularity); "n/a" means the interaction stayed under the 16 ms reporting threshold.`,
    ``,
  ].join("\n");

  fs.mkdirSync(OUT_DIR, { recursive: true });
  fs.writeFileSync(path.join(OUT_DIR, `${LABEL}.json`), JSON.stringify(result, null, 2));
  fs.writeFileSync(path.join(OUT_DIR, `${LABEL}.md`), md);
  console.log("\n" + md);
  if (process.env.GITHUB_STEP_SUMMARY) fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, md + "\n");
  console.log(`wrote ${path.relative(root, OUT_DIR)}/${LABEL}.{json,md}`);
}

main().catch((err) => {
  console.error(err);
  server?.kill("SIGTERM");
  process.exit(1);
});
