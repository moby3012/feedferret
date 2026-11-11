import { test, expect } from "./helpers/csp-test";

// L3 (PR 6): report mode is the default. The old static policy stays enforced on
// pages; the per-request nonce policy is report-only. Every spec runs under the
// CSP audit fixture (helpers/csp-test.ts), which fails on any violation report.

const LEGACY_SCRIPT_SRC = "script-src 'self' 'unsafe-inline' 'unsafe-eval'";

test("documents get one enforced policy plus a fresh report-only nonce policy, uncached", async ({ page }) => {
  const nonces: string[] = [];
  for (let i = 0; i < 2; i++) {
    const response = await page.goto("/login");
    const headers = response!.headers();
    // Playwright joins repeated headers with "\n": exactly one enforced policy, the legacy one.
    expect(headers["content-security-policy"]).toContain(LEGACY_SCRIPT_SRC);
    expect(headers["content-security-policy"]).not.toContain("\n");
    const policy = headers["content-security-policy-report-only"];
    expect(policy).not.toContain("\n");
    expect(policy).toContain("'strict-dynamic'");
    expect(policy).toContain("report-uri /api/csp-report");
    expect(headers["reporting-endpoints"]).toBe('csp="/api/csp-report"');
    const nonce = /'nonce-([^']+)'/.exec(policy)![1];
    nonces.push(nonce);
    expect(headers["cache-control"]).toMatch(/private/);
    expect(headers["cache-control"]).toMatch(/no-store/);
    // Every script tag in the served HTML — Next's framework chunks and Flight data and
    // next-themes' inline one — carries it (chunks loaded later are trusted via 'strict-dynamic').
    const tags = (await response!.text()).match(/<script\b[^>]*>/g) ?? [];
    expect(tags.length).toBeGreaterThan(2);
    expect(tags.filter((tag) => !tag.includes(`nonce="${nonce}"`))).toEqual([]);
  }
  expect(nonces[0]).not.toBe(nonces[1]);
});

test("auth redirects carry the page policy", async ({ request }) => {
  const redirect = await request.get("/", { maxRedirects: 0 });
  expect(redirect.status()).toBeGreaterThanOrEqual(300);
  expect(redirect.headers()["content-security-policy"]).toContain(LEGACY_SCRIPT_SRC);
  expect(redirect.headers()["content-security-policy-report-only"]).toContain("'nonce-");
});

test("paths outside the proxy matcher keep exactly one static policy", async ({ request }) => {
  const expected: Record<string, string> = {
    "/api/auth/csrf": "default-src 'none'",
    "/offline.html": "script-src 'self';",
    "/sw.js": LEGACY_SCRIPT_SRC,
    "/offline-reader.js": LEGACY_SCRIPT_SRC,
    "/manifest.json": LEGACY_SCRIPT_SRC,
    "/logo.svg": LEGACY_SCRIPT_SRC,
    "/icon-192.png": LEGACY_SCRIPT_SRC,
  };
  for (const [path, fragment] of Object.entries(expected)) {
    const headers = (await request.get(path, { maxRedirects: 0 })).headers();
    expect(headers["content-security-policy"], path).toContain(fragment);
    expect(headers["content-security-policy"], path).not.toContain("\n");
    expect(headers["content-security-policy-report-only"], path).toBeUndefined();
  }
});

test("setup, unknown routes and the offline page run without violations", async ({ page }) => {
  await page.goto("/setup");
  await page.goto("/not-a-real-route");
  await page.goto("/offline.html");
  await expect(page.getByRole("heading", { name: "You are offline" })).toBeVisible();
  // The retry handler is bound by offline-reader.js (no inline onclick under script-src 'self').
  const reload = page.waitForEvent("load");
  await page.getByRole("button", { name: "Try again" }).click();
  await reload;
});

test("the report endpoint accepts reports without a session and never echoes them", async ({ request }) => {
  const response = await request.post("/api/csp-report", {
    headers: { "content-type": "application/csp-report" },
    data: JSON.stringify({ "csp-report": { "effective-directive": "script-src-elem", "document-uri": "http://x/?token=secret" } }),
  });
  expect(response.status()).toBe(204);
  expect(await response.text()).toBe("");
});
