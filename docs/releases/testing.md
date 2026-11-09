# Testing

## Running the E2E harness locally (seeded, authenticated)

Everything below runs **offline**: a fresh SQLite database is seeded, a tiny local feed server and a production `next start` are booted by Playwright, and no external service is needed. The same commands run in GitHub Actions (`.github/workflows/ci.yml`, job `E2E (seeded, authenticated)`).

```bash
pnpm install
npx playwright install chromium          # once
pnpm run prisma:generate                 # once / after schema changes
pnpm run build                           # E2E runs against the production build
pnpm run test:e2e                        # all projects
pnpm run test:e2e -- --project=mobile    # one project (chromium | desktop | mobile)
pnpm run test:e2e -- navigation          # one spec file
pnpm run test:e2e:a11y                   # public-page axe gate only
```

Re-run `pnpm run build` after app code changes — the harness never builds for you. Default port is **3100** (override with `E2E_PORT`) so a dev server on :3000 is never picked up by accident; the fixture feed server uses :4010 (`E2E_FIXTURE_PORT`). `PLAYWRIGHT_BASE_URL` is for pointing at an externally started server that was seeded with `scripts/e2e-seed.mjs` (and whose `.e2e/` DB the specs can read).

### What the harness does

| Piece | File | Notes |
|---|---|---|
| Seed | `scripts/e2e-seed.mjs` | New SQLite DB in `.e2e/e2e.db` (gitignored; the script refuses paths outside `.e2e/` and never reads `DATABASE_URL`). 3 admin users (`desktop`, `mobile`, `perf`; password in `.e2e/manifest.json`, identical independent datasets so projects never interfere), 3 categories, 8 feeds, **300 articles** (long content, images, code blocks, 2 labels, starred, read-later, ~38 % read), a pristine-flag snapshot table (`e2e_pristine`) used to reset state between tests. |
| Dataset | `e2e/fixtures/data.mjs` | Deterministic generator shared by seed, fixture feed server and specs. |
| Fixture feeds | `e2e/fixtures/feed-server.mjs` | Serves the same articles as RSS 2.0 / Atom on `127.0.0.1:4010`. Feed URLs in the DB point here. **FeedFerret's SSRF guard blocks localhost**, so the app can't fetch them: articles are inserted directly into the DB and no test-only SSRF bypass exists. |
| Global setup | `e2e/global-setup.ts` | Logs in through the real login form once per seeded user and writes `e2e/.auth/<user>.json` (storageState). |
| Test fixture | `e2e/helpers/test.ts`, `e2e/helpers/db.ts` | `app` fixture = small page object (selectors live here) + automatic reset of read/star/read-later flags before each test. Assertions can read persisted flags straight from the SQLite file. |
| Projects | `playwright.config.ts` | `chromium` (public pages), `desktop` (1280×800), `mobile` (390×844, touch, `isMobile`). Serial (`workers: 1`) because one DB is shared. |

Specs (`e2e/`): `auth.spec.ts`, `accessibility.spec.ts` (public, blocking at serious/critical), `app/navigation.spec.ts`, `app/triage.spec.ts` (read/unread, star, read-later, mark-all-read incl. sidebar counts + DB), `app/search-settings-palette.spec.ts`, `authenticated-a11y.spec.ts` (**non-blocking**: violations become test annotations and CI job-summary lines).

### Characterization tests and `test.fixme`

The authenticated specs document **current** behaviour, including known-bad behaviour only where it is a stable fact (e.g. the URL stays `/` while a reader is open). Desired behaviour from the UX/code audits is written as `test.fixme` with the audit ID in the title — enable them (remove `.fixme`) in the PR that fixes the behaviour:

- `P1-03` browser/Android back from the reader returns to the list instead of leaving the app
- `P1-03` reload restores selected feed + open article
- `P1-11` mobile PWA "Add to Home Screen" modal must not block first use (currently asserted as-is in a non-fixme test)

When selectors change in a refactor, update `e2e/helpers/test.ts` first, not every spec.

### Gotchas

- The **headless Chromium shell crashes the renderer** when the service worker calls the Badge API (`blink.mojom.BadgeService`). The harness therefore sets `serviceWorkers: "block"`; the SW isn't under test and would add cross-test caching.
- Credentials sign-in is rate-limited (10 POSTs / 15 min / IP, in memory). The harness logs in ~3 times per run; don't add per-test UI logins — use storageState.
- The mobile PWA install modal is suppressed through `localStorage` (`feedferret:pwa-install-prompt-dismissed`) except in the test that characterizes it.

## Performance baseline

```bash
pnpm run build
pnpm run perf:measure                          # 5 cold runs, own server + seeded DB on :3200
pnpm run perf:measure -- --runs 3 --label before-d1
```

`scripts/perf-measure.mjs` (Playwright library + CDP, no extra deps) measures the authenticated `/` view with a mobile profile — Pixel 7 emulation, **4× CPU throttle, Slow 4G (1.6 Mbps / 150 ms RTT)**, cold cache per run — and reports the median of N runs: LCP, FCP, CLS, TBT, time-to-first-article-row, request count / bytes at cold start (incl. Next-Action POSTs), INP-proxy via Event Timing for *open article*, *mark read* and *star*, tap→reader-painted, and first-load JS (gz) for `/` from `.next` manifests (same method as `.pm/audit-perf.md` §2.2). Results go to `perf-results/<label>.{json,md}` (gitignored) and to `$GITHUB_STEP_SUMMARY` in CI. The committed reference is [`docs/perf/baseline-2026-11.md`](../perf/baseline-2026-11.md). In CI the manual `Perf baseline` workflow (`workflow_dispatch`, soft-fail) runs the same script; compare CI runs with CI runs, local with local.

---

# Test Coverage Plan (historical)

> The plan below predates the harness above. Vitest unit tests and the E2E harness now exist; the remaining items are still a useful checklist.

> Goal: Ship a meaningful test suite before v1.2 merges.
> Current state: no automated tests. CI runs lint + typecheck + build only.

---

## Vitest Unit Tests

Scope: `lib/` functions only. No React components, no database, no network. Tests must run in under 10 seconds total.

Install: `pnpm add -D vitest @vitest/coverage-v8`

Add to `package.json`:
```json
"test": "vitest run",
"test:watch": "vitest",
"test:coverage": "vitest run --coverage"
```

### `lib/search.ts` — Query Parser

- All 15+ token types parse correctly: `is:unread`, `is:starred`, `is:read-later`, `feed:`, `category:`, `label:`, `from:`, `before:`, `after:`, `has:image`, `has:summary`, `#tag`, `"exact phrase"`, bare keyword, `-negation`
- Multi-token queries produce correct AST
- Empty query returns match-all
- Query exceeding 1 000 characters is rejected
- Malformed date tokens fall back gracefully (no throw)
- Unicode keywords handled without truncation

### `lib/validation.ts` — Input Limits

- Feed URL at exactly 2 048 characters passes; 2 049 characters fails
- Feed URL with `http://` and `https://` schemes pass; `ftp://` fails
- OPML file at exactly 5 MB passes; 5 MB + 1 byte fails
- Label name at exactly 100 characters passes; 101 characters fails
- Search query at exactly 1 000 characters passes; 1 001 characters fails
- Null and empty string inputs handled without throw

### `lib/token.ts` — API Token Handling

- Generated token has the `ff_` prefix
- Generated token base64url-encodes 32 bytes (length = 3 + ~43 characters)
- Hashing is deterministic: `hash(token) === hash(token)` called twice
- Two different tokens produce different hashes
- Rotation: after `rotate()`, the new hash is different from the old hash
- Constant-time comparison helper returns true for identical hashes, false for different

### `lib/rate-limit.ts` — Sliding Window

- First request in a fresh window is allowed; counter starts at 1
- Requests up to the limit are allowed; request at limit + 1 is rejected with HTTP 429
- Window resets after the window duration: requests in the new window start the counter again
- `X-RateLimit-Remaining` and `X-RateLimit-Reset` values are accurate
- Different keys (different users or IPs) have independent windows

### `lib/feed-fetcher.ts` — URL Safety

- `http://localhost/feed` is blocked
- `http://127.0.0.1/feed` is blocked
- `http://192.168.1.1/feed` is blocked
- `http://10.0.0.1/feed` is blocked
- `http://172.16.0.1/feed` is blocked
- `http://169.254.1.1/feed` is blocked
- `https://example.com/feed` is allowed
- `ftp://example.com/feed` is blocked (non-HTTP/HTTPS scheme)
- URL normalization: trailing slash, `www.` prefix, query-string deduplication produce the same canonical URL

---

## Playwright E2E Tests

Scope: critical user journeys only. No unit-level logic — those are covered by Vitest. Tests run against a real server with a test database (SQLite in CI, PostgreSQL locally via Docker).

Install: `pnpm add -D @playwright/test`

Config file: `playwright.config.ts` at repo root. Test files in `e2e/`.

### Login + 2FA

1. Register a new account
2. Enable TOTP 2FA via Settings → Security; save the TOTP secret
3. Log out
4. Log in with correct password + valid TOTP code — succeeds
5. Log in with correct password + wrong TOTP code — rejected with error message

### Onboarding Wizard (6 Steps)

1. Register a fresh account; wizard appears automatically
2. Step through all 6 steps without error
3. Confirm feeds added via starter pack are visible in the sidebar after completion
4. Re-visiting `/` after completion does not show the wizard again

### Add Feed → Sync → Read Article

1. Add a valid RSS feed URL via Feed Management
2. Trigger a manual sync
3. Confirm at least one article appears in the article list
4. Open the article; confirm it renders without error
5. Mark the article as read; confirm unread count decrements

### OPML Import + Export Round-Trip

1. Import an OPML file with at least 3 feeds
2. Confirm all 3 feeds appear in Feed Management
3. Export OPML
4. Confirm the exported file contains the 3 feed URLs

### Saved Search Create + Share

1. Enter a search query; save it with a name
2. Confirm the saved search appears in the sidebar
3. Open the saved search public URL (unauthenticated); confirm articles are visible
4. Copy the RSS export URL; fetch it; confirm valid RSS XML is returned

### Keyword Alert Create + Trigger

1. Create a keyword alert matching a specific token that appears in a known test article
2. Trigger a feed sync that delivers the matching article
3. Confirm the alert fires: notification appears in the in-app notification list

### Account Deletion (GDPR)

1. Create an account with at least one feed and one article read
2. Navigate to Settings → Account → Delete Account
3. Confirm deletion with the confirmation prompt
4. Verify the session is terminated (redirected to login)
5. Verify the account cannot log in after deletion

---

## CI Additions

Add the following steps to `.github/workflows/ci.yml` after the existing lint + typecheck + build steps:

```yaml
- name: Run unit tests
  run: pnpm test

- name: Run E2E tests
  run: pnpm playwright test

- name: Accessibility audit
  run: pnpm playwright test --project=a11y
```

The `a11y` Playwright project runs `axe-playwright` on these pages: Login, Home (article list), Feed Management, Settings (Appearance tab), Article Reader. Any `critical` or `serious` axe violation fails the build.

---

## Local Developer Experience

- `.husky/pre-commit` hook with `pnpm lint-staged`: runs ESLint and `tsc --noEmit` on staged `.ts`/`.tsx` files only
- Off by default — opt in by running `pnpm husky install`
- Document the opt-in step in `CONTRIBUTING.md`
- `pnpm test:watch` for TDD during `lib/` work — Vitest re-runs only affected test files on save
