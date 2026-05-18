# Test Coverage Plan

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
