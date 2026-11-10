import path from "node:path";
import { randomBytes } from "node:crypto";
import { defineConfig, devices } from "@playwright/test";

/**
 * E2E harness.
 *
 * - Boots a SEEDED, disposable SQLite DB (scripts/e2e-seed.mjs -> .e2e/e2e.db)
 *   and a production `next start` against it, plus a tiny local fixture feed
 *   server. No internet, no external services; the same config runs locally
 *   and in GitHub Actions (build the app first: `pnpm run build`).
 * - Authenticated projects reuse a storageState written once by
 *   e2e/global-setup.ts (one seeded user per project so the two projects can
 *   never interfere with each other's read/star state).
 * - The default port is 3100 (not 3000) so a dev server on :3000 is never
 *   mistaken for the test server. Override with E2E_PORT.
 */
const PORT = Number(process.env.E2E_PORT || 3100);
const FIXTURE_PORT = Number(process.env.E2E_FIXTURE_PORT || 4010);
const BASE_URL = process.env.PLAYWRIGHT_BASE_URL || `http://localhost:${PORT}`;
const DB_PATH = path.resolve(".e2e", "e2e.db");
// K2 fake AI gate (lib/ai/fake.ts): a random token per run. The seed writes it
// next to the DB (`e2e.db.harness`); the production server enables the fake
// provider only when its env token matches that file. `??=` keeps one token
// for the whole run (workers inherit the env of the main process).
const HARNESS_TOKEN = (process.env.FEEDFERRET_E2E_HARNESS ??= randomBytes(24).toString("hex"));

const AUTHED = ["**/app/**/*.spec.ts", "**/authenticated-a11y.spec.ts"];

export default defineConfig({
  testDir: "./e2e",
  globalSetup: "./e2e/global-setup.ts",
  // One shared DB: keep tests deterministic and serial (suite is small).
  fullyParallel: false,
  workers: 1,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? [["list"], ["html", { open: "never" }]] : "list",
  use: {
    baseURL: BASE_URL,
    locale: "en-US",
    // The headless Chromium shell crashes the renderer when the service worker
    // calls the Badge API; the SW is not under test and would add caching noise.
    serviceWorkers: "block",
    timezoneId: "UTC",
    trace: "on-first-retry",
  },
  projects: [
    {
      // Public pages, no session.
      name: "chromium",
      testIgnore: AUTHED,
      use: { ...devices["Desktop Chrome"] },
    },
    {
      name: "desktop",
      testMatch: AUTHED,
      metadata: { user: "desktop" },
      use: {
        ...devices["Desktop Chrome"],
        viewport: { width: 1280, height: 800 },
        storageState: "e2e/.auth/desktop.json",
      },
    },
    {
      name: "mobile",
      testMatch: AUTHED,
      metadata: { user: "mobile" },
      use: {
        ...devices["Pixel 7"],
        viewport: { width: 390, height: 844 },
        hasTouch: true,
        isMobile: true,
        storageState: "e2e/.auth/mobile.json",
      },
    },
  ],
  webServer: [
    {
      command: `node e2e/fixtures/feed-server.mjs`,
      url: `http://127.0.0.1:${FIXTURE_PORT}/healthz`,
      reuseExistingServer: !process.env.CI,
      timeout: 30_000,
    },
    {
      // Seed a fresh DB, then serve the production build (run `pnpm run build`
      // first). `next start` directly -- NOT `pnpm run start`, whose
      // `prisma db push --accept-data-loss` would run against the seeded DB.
      command: `node scripts/e2e-seed.mjs && npx next start -p ${PORT}`,
      url: `${BASE_URL}/login`,
      // Always a fresh seed: a leftover server would hold stale state.
      reuseExistingServer: false,
      timeout: 180_000,
      env: {
        DATABASE_PROVIDER: "sqlite",
        DATABASE_URL: `file:${DB_PATH}`,
        AUTH_SECRET: "e2e-0123456789abcdef0123456789abcd-k",
        AUTH_URL: BASE_URL,
        NEXTAUTH_URL: BASE_URL,
        AUTH_TRUST_HOST: "true",
        DISABLE_BACKGROUND_SYNC: "true",
        // K2: the deterministic fake AI provider (lib/ai/fake.ts). Only honoured
        // with this flag AND the per-run harness token matching the marker file
        // the seed writes next to the disposable DB — never in a deployment.
        FEEDFERRET_FAKE_AI: "1",
        FEEDFERRET_E2E_HARNESS: HARNESS_TOKEN,
        NEXT_TELEMETRY_DISABLED: "1",
        NODE_ENV: "production",
      },
    },
  ],
});
