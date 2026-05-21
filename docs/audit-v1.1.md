# FeedFerret v1.1 — Pre-Release Audit

> Conducted: 2026-05-21  
> Scope: Security, components, infrastructure, i18n, dependencies  
> Status: **All 9 blockers resolved 2026-05-21 — v1.1.0 ready to tag**

---

## Executive Summary

Four parallel audits were run across the full codebase. Findings are grouped by domain and sorted by severity within each group. Items marked 🔴 are release blockers; 🟡 are important but non-blocking; ⚪ are low-priority cleanup.

| Domain | 🔴 Blocker | 🟡 Important | ⚪ Low |
|---|---|---|---|
| Security | 0 ✅ | 6 | 5 |
| Components & TypeScript | 0 ✅ | 4 | 3 |
| Infrastructure & Build | 0 ✅ | 6 | 3 |
| i18n & Translations | 0 ✅ | 8 | 2 |
| **Total** | **0 (all fixed)** | **24** | **13** |

---

## 1. Security

### ✅ FIXED — Sync secret timing-safe comparison

**File:** `app/api/sync/route.ts` · Lines 15–19  
The comparison `authHeader !== \`Bearer ${process.env.SYNC_SECRET}\`` uses standard string equality, which is vulnerable to timing attacks.

```typescript
// Fix: use crypto.timingSafeEqual
const expected = Buffer.from(`Bearer ${process.env.SYNC_SECRET ?? ""}`);
const actual   = Buffer.from(authHeader ?? "");
if (actual.length !== expected.length || !crypto.timingSafeEqual(actual, expected)) {
  return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
}
```

---

### ✅ FIXED — API v1 error message leaks internal details

**File:** `app/api/v1/[...path]/route.ts` · Line 804  
`apiError(error instanceof Error ? error.message : String(error), 500)` returns raw exception messages to clients. Prisma errors include table names, column names, and constraint details.

```typescript
// Fix:
logger.error("[api/v1]", error);
res = apiError("Internal server error", 500);
```

---

### 🟡 Fever API — no rate limiting

**File:** `app/api/fever/route.ts`  
The Fever API endpoint has zero rate limiting. Trivial to scrape all articles or enumerate IDs. Apply the existing `checkRateLimit` helper used elsewhere in the codebase.

---

### 🟡 GReader API — no rate limiting

**File:** `app/api/greader/[...path]/route.ts`  
Same as Fever: no per-user or per-IP rate limiting. Apply `checkRateLimit`.

---

### 🟡 Credentials status endpoint — 2FA status enumeration

**File:** `app/api/auth/credentials-status/route.ts` · Lines 25–27  
Returns `requiresTwoFactor: true/false` for existing users. Allows enumeration of valid email addresses and which accounts have 2FA. Consider returning the same shape for all requests regardless of whether the user exists.

---

### 🟡 Register endpoint — email enumeration

**File:** `app/api/register/route.ts` · Line 39  
Returns `"User already exists"` when a duplicate email is submitted, allowing enumeration of registered accounts. Return a generic success-shaped response for existing accounts to prevent enumeration.

---

### 🟡 Push subscribe — no enum validation

**File:** `app/api/push/subscribe/route.ts` · Lines 35, 52  
`platform` and `pushFrequency` are written to DB without validating against an allowlist. Accepts arbitrary strings.

```typescript
const VALID_PLATFORMS    = ["web", "android", "ios"] as const;
const VALID_FREQUENCIES  = ["instant", "hourly", "daily"] as const;
```

---

### 🟡 2FA secret not encrypted at rest

**File:** `prisma/schema.prisma` · Line 17  
`twoFactorSecret String?` is stored in plaintext. All other secrets (`aiApiKey`, `sendgridApiKey`, etc.) are marked `// encrypted at rest`. Extend the encryption wrapper to cover this field.

---

### ⚪ GReader token — HMAC only on userId

**File:** `lib/greader.ts` · Lines 17–27  
Token is `userId.hmac(userId)`. If an attacker knows a userId (UUIDs from DB leaks), they can compute valid tokens. A session nonce would bind the token to a specific login session. Low exploitability in practice since UUIDs are unguessable, but worth hardening post-v1.1.

---

### ⚪ Internal API key — no brute-force delay

**File:** `app/api/internal/provision-user/route.ts`  
Rate limiting already fires before auth, so brute-force is already constrained. Add a fixed `await new Promise(r => setTimeout(r, 100))` on auth failure to add friction. Minor.

---

### ⚪ Error logging — raw request data to Sentry

Once Sentry is wired (v1.3), ensure request bodies containing passwords, tokens, or 2FA codes are scrubbed before forwarding to Sentry. Implement a `beforeSend` filter.

---

## 2. Components & TypeScript

### ✅ FIXED — No error boundaries anywhere

**Files:** `app/layout.tsx`, `app/page.tsx`, all components  
The entire app has no `error.tsx` or `<ErrorBoundary>` at any level. Any unhandled component throw produces a white screen with no fallback UI and no error reporting.

**Minimum required:**
- `app/error.tsx` — global boundary (Next.js App Router convention)
- `app/global-error.tsx` — catches layout-level errors
- Wrapping `<ArticleList>` and `<ArticleReader>` in `<Suspense>` with error fallback

---

### 🟡 TypeScript `as any` — 11+ instances

Weaken type safety and hide real type errors. Listed by file:

| File | Lines | Instance |
|---|---|---|
| `app/api/v1/[...path]/route.ts` | 429, 431 | `(parentId \|\| null) as any` |
| `app/page.tsx` | 471, 515, 705 | `feeds as any[]` |
| `app/server-settings/page.tsx` | 8 | `(session.user as any).role` |
| `components/feed-edit-dialog.tsx` | 113 | `(feed as any).updateFrequency` |
| `components/feed-management.tsx` | 561, 811, 891, 1805, 1973, 1978, 2155 | `categories as any[]`, `feeds as any[]` |
| `components/rss-sidebar.tsx` | 336, 762 | `SpoilerIcon as any`, `notifications as any[]` |
| `components/settings-form.tsx` | 1870 | `client.notesKey as any` |
| `lib/ai-summary.ts` | 40 | `(config as any).provider` |
| `lib/auto-read-rules.ts` | 201 | `(rule as any).webhookConfigs` |
| `lib/background-sync.ts` | 16 | `globalThis as any` |
| `lib/feed-fetcher.ts` | 230, 237 | `(init as any).dispatcher` |

Most of these indicate missing fields on types rather than genuine polymorphism — the types should be extended.

---

### 🟡 Silent fetch failures in RssSidebar

**File:** `components/rss-sidebar.tsx` · Lines 187–194  
`fetch("/api/instance")` silently swallows errors (`.catch(() => {})`). Branding fails to load with no user feedback. At minimum, log to the `logger`.

---

### 🟡 Missing aria-labels on collapsed sidebar buttons

**File:** `components/rss-sidebar.tsx` · Lines 425–446  
Icon-only buttons in the collapsed sidebar state have no `aria-label`. Screen reader users cannot identify them.

---

### 🟡 Bare `.catch(console.error)` calls

**File:** `app/page.tsx` · Line 266  
Background sync errors are silently discarded to the browser console. Route through `logger.error()` so they will be picked up by Sentry once wired.

---

### ⚪ Race condition — article list scroll-back

**File:** `components/article-list.tsx` · Lines 192–201  
`scrollBackToId` effect does not guard against the element not yet being in the DOM when the effect fires. Unlikely to surface in practice but could cause a missed scroll on fast navigation.

---

### ⚪ `onPullToRefresh` missing memoization guard

**File:** `components/article-list.tsx` · Line 281  
`onPullToRefresh` is in the `useEffect` dependency array. If the parent passes a new function reference each render, the pull-to-refresh listeners are needlessly re-attached. Wrap the prop in `useCallback` at the call site in `app/page.tsx`.

---

### ⚪ Debug `console.error` in server-management-dialog

**File:** `components/server-management-dialog.tsx` · Line 1536  
`console.error(error)` before a toast is acceptable, but should route through `logger.error()` for consistency and future Sentry capture.

---

## 3. Infrastructure & Build

### ✅ FIXED — Tests and translations NOT in CI

**File:** `.github/workflows/ci.yml`  
CI runs lint + typecheck + build only. Two critical checks are completely absent:

```yaml
# Missing steps to add to ci.yml:
- name: Test
  run: pnpm run test

- name: Translations
  run: pnpm run translations:check
```

PRs can currently merge with broken tests or missing translation keys.

---

### ✅ FIXED — pnpm version mismatch across environments

| Location | Version |
|---|---|
| `package.json` (`packageManager`) | `9.14.2` |
| `Dockerfile` (lines 11, 51) | `9.14.2` |
| `.github/workflows/ci.yml` (line 22) | `11.0.8` |
| `.github/workflows/pwa.yml` | (unspecified — inherits default) |

CI generates a `pnpm-lock.yaml` with v11 format. The Dockerfile installs v9 and attempts to read it. This is a latent production build failure. All four locations must be pinned to the same version.

---

### ✅ FIXED — Missing DB indexes on high-traffic queries

The following foreign keys have no index and will cause full table scans at scale:

| Model | Missing Index | Impact |
|---|---|---|
| `Account` | `@@index([userId])` | Loading OAuth accounts per user |
| `Session` | `@@index([userId])` | Session lookups per user |
| `Category` | `@@index([userId])`, `@@index([parentId])` | Listing categories, nested queries |
| `Feed` | `@@index([userId])`, `@@index([categoryId])` | Core feed listing (every page load) |
| `Notification` | `@@index([feedId])` | Feed-filtered notification queries |
| `Article` | `@@index([spoilerRuleId])` | Rule-based spoiler queries |

`Feed.userId` is the most critical — it is queried on every authenticated page load.

---

### 🟡 No HEALTHCHECK in Dockerfile

**File:** `Dockerfile` · Line 75–78  
Kubernetes and Docker health checks mark the container healthy immediately. If the Next.js process hangs, no orchestrator will restart it.

```dockerfile
HEALTHCHECK --interval=30s --timeout=5s --start-period=15s \
  CMD curl -sf http://localhost:3000/api/health || exit 1
```

---

### 🟡 `next-auth` still on `5.0.0-beta.31`

**File:** `package.json` · Line 77  
All other dependencies are on stable releases. `next-auth` v5 stable has not shipped yet (tracked in `maintenance.md`). This is the authentication core — any beta-introduced regression is high impact. Monitor https://github.com/nextauthjs/next-auth for v5.0.0 stable.

---

### 🟡 HSTS header missing

**File:** `next.config.mjs`  
All major security headers are present (X-Frame-Options, X-Content-Type-Options, Referrer-Policy, Permissions-Policy, CSP) but `Strict-Transport-Security` is absent. Self-hosters running HTTPS are unprotected against protocol downgrade.

```typescript
{ key: "Strict-Transport-Security", value: "max-age=31536000; includeSubDomains" }
```

---

### 🟡 Undocumented environment variables

**File:** `.env.example`  
Two env vars used in `lib/background-sync.ts` and `app/api/sync/status/route.ts` are not documented:
- `DISABLE_BACKGROUND_SYNC` — disables the sync scheduler entirely
- `BACKGROUND_SYNC_INTERVAL_MINUTES` — overrides default sync frequency

Self-hosters cannot discover or configure these.

---

### 🟡 `@prisma/client` vs `prisma` version pinning mismatch

**File:** `package.json`  
`@prisma/client` is pinned exactly at `7.8.0`, but `prisma` (CLI) uses `^7.8.0` (caret). If the CLI auto-updates to `7.9.0`, client and CLI are mismatched. Pin both identically:

```json
"@prisma/client": "7.8.0",
"prisma": "7.8.0"
```

---

### 🟡 Duplicate migration files with spaces

**File:** `prisma/migrations/`  
Multiple migration directories contain both `migration.sql` and `migration 2.sql`. Prisma only executes `migration.sql`; the space-named files are dead code. Confusing when reading migration history. Delete the space-named files.

---

### ⚪ LoginAttempt uses `onDelete: SetNull`

**File:** `prisma/schema.prisma` · Line 428  
When a user is deleted, their `LoginAttempt` records become orphaned with `userId = null`. Decide: audit trail preserved (current — intentional) vs. delete with user (cascade). Document the intent in a schema comment.

---

### ⚪ Dockerfile touches empty SQLite file

**File:** `Dockerfile` · Line 57  
`touch /app/data/dev.db` creates a 0-byte file. Prisma will overwrite it anyway. No functional impact but misleading in a production image.

---

### ⚪ CSP `unsafe-eval` documented but unresolved

**File:** `next.config.mjs` · Lines 44–45  
`script-src 'self' 'unsafe-inline' 'unsafe-eval'` is required by Next.js App Router without nonce configuration. Tracked in `maintenance.md`. Scheduled for resolution when Next.js provides a stable nonce API. No action needed now — already documented.

---

## 4. i18n & Translations

### ✅ FIXED — Test email and push notification test not translated

**Files:** `lib/mail.ts` · Lines 391–393; `app/actions/settings.ts` · Line 443

`sendTestSystemEmail()` sends a hardcoded English subject and body directly to users. Same for the push notification test.

```typescript
// mail.ts — needs createEmailTranslator() + new keys in en.json/de.json
subject: "FeedFerret mail provider test"
body:    "If you received this message, your FeedFerret email provider is configured correctly."

// settings.ts
body:    "This is a test from your FeedFerret instance. Notifications are working correctly."
```

---

### ✅ FIXED — "Skip to content" skip link hardcoded

**File:** `app/layout.tsx` · Line 79  
The accessibility skip link reads `"Skip to content"` in hardcoded English for all locales including German. This is the first element a screen reader encounters on every page.

---

### ✅ FIXED — Spoiler section UI strings hardcoded

**File:** `app/page.tsx` · Lines 207, 183, 185–186  
- `"Clearing…"` / `"Clear all spoiler flags"` — button labels  
- `"Spoiler content ahead"` — section heading  
- Full description paragraph — hardcoded English

These are high-visibility page elements shown to German users in English.

---

### 🟡 30+ hardcoded toast strings in server-management-dialog

**File:** `components/server-management-dialog.tsx` · Lines 116, 130, 141, 151, 164, 166, 177, 179, 193, 195, 204, 208, 211, 219, 326, 328, 354, 358, 1364, 1367, 1370, 1381, 1386, 1537, 1552, 1554, 1563, 1565, 1595  
All toast messages in the server management dialog are hardcoded English. Admins who set the instance to German see English toast messages. Representative examples:

```
"Failed to load server data"  "Settings saved"  "Failed to update settings"
"Test email sent to ${result.sentTo}"  "User deleted"  "${user.email} suspended"
"Imported ${data.totalAdded} new feeds"  "Generated new VAPID key pair"
```

---

### 🟡 Fallback strings not translated

**File:** `app/page.tsx` · Lines 61, 334, 337, 340  

| Code | Displayed when |
|---|---|
| `a.author \|\| "Unknown"` | Article has no author |
| `"Feed"` | Feed name missing |
| `"Label"` | Label name missing |
| `"Saved Search"` | Saved search name missing |

---

### 🟡 ARIA region labels hardcoded

**File:** `app/page.tsx` · Lines 805, 867, 895, 967  
`aria-label="Article list"` and `aria-label="Article reader"` are hardcoded. Screen readers announce these in English regardless of locale.

---

### 🟡 Search placeholder hardcoded

**File:** `app/page.tsx` · Line 1011  
`placeholder="Enter search term — try author:, intitle:, is:unread, label:"` — the longest user-visible placeholder in the app is not translated.

---

### 🟡 Alert help text in feed-management

**File:** `components/feed-management.tsx` · Lines 2262–2314  
The "How alerts work" help section (header, description, examples, syntax tip) is entirely hardcoded English.

---

### 🟡 Native `confirm()` dialog in server-management-dialog

**File:** `components/server-management-dialog.tsx` · Line 1377  
`confirm("Clear all feeds from discovery catalog?")` uses the browser's native dialog which cannot access the translation system. Replace with a translated `<AlertDialog>` component (already used elsewhere in the project).

---

### 🟡 Inconsistent "All Articles" capitalisation

**File:** `app/page.tsx` · Lines 105, 230, 240, 494; `app/actions/feeds.ts` · Lines 675, 686, 1060  
The string `"All Articles"` (Title Case) is used as both a display label and a logic sentinel. `messages/en.json` has `sidebar.allArticles: "All articles"` (sentence case). The casing is inconsistent and the sentinel logic bypasses i18n entirely.

---

### 🟡 `deleteAccount.typeToConfirm` inconsistency (German)

**File:** `messages/de.json`  
The instruction text references `'Konto loeschen'` (with `oe` instead of `ö`) while the `confirmPlaceholder` key correctly uses `"Konto löschen"`. The confirmation check reads the placeholder value, so functionally it works — but the instruction is confusing for German users.

---

### ⚪ Language names hardcoded in selects

**Files:** `components/settings-form.tsx` · Lines 455–456; `components/server-management-dialog.tsx` · Lines 544–545  
`"English"` and `"Deutsch"` are hardcoded in `<SelectItem>` values. These are proper nouns and rendering them in the UI's current locale (e.g., "Englisch" for German) is a debatable preference. Not a functional issue.

---

## 5. What Is Already Fine (Non-Issues)

- **GReader 2FA bypass** — The code at `lib/greader.ts` line 48 already rejects Basic Auth for 2FA-enabled users. No action needed.
- **Admin scope enforcement** — `app/api/v1/[...path]/route.ts` correctly requires `admin` scope on admin paths. Non-v1 routes use session auth.
- **Cascade deletes** — All major user-owned models cascade correctly. Orphaned records are limited to `LoginAttempt` (intentional audit trail).
- **Event listener cleanup** — All `useEffect` hooks in `article-list.tsx`, `article-reader.tsx`, `pwa-install-prompt.tsx` properly return cleanup functions.
- **German translation quality** — Spot-check of 30 entries found no untranslated copy, no missing umlauts, no wrong gender articles. Machine translation quality is acceptable.
- **ICU syntax** — No syntax errors found in `messages/en.json` or `messages/de.json`.
- **next-intl wiring** — `app/layout.tsx`, `i18n/request.ts`, and `next.config.mjs` are correctly configured. Cookie-based locale detection (no URL prefix) is intentional and documented.
- **Digest email translation** — `lib/digest-email.ts` is fully translated via `createEmailTranslator`.
- **Prisma parameterized queries** — No SQL injection risk; all DB access goes through Prisma's query builder.

---

## 6. Prioritised Fix List

### Must fix before v1.1 tag (🔴 Blockers — 9 items)

| # | Fix | File(s) |
|---|---|---|
| B1 | Add `pnpm run test` + `pnpm run translations:check` to CI | `.github/workflows/ci.yml` |
| B2 | Unify pnpm version (all 4 locations) | `package.json`, `Dockerfile`, both CI workflows |
| B3 | Add DB indexes (Feed.userId, Category.userId, Account.userId, Session.userId) | `prisma/schema.prisma` |
| B4 | Add global error boundary (`app/error.tsx`, `app/global-error.tsx`) | New files |
| B5 | Fix timing-safe comparison for SYNC_SECRET | `app/api/sync/route.ts` |
| B6 | Stop leaking `error.message` in API v1 catch block | `app/api/v1/[...path]/route.ts` |
| B7 | Translate test email + push test strings | `lib/mail.ts`, `app/actions/settings.ts` |
| B8 | Translate "Skip to content" skip link | `app/layout.tsx` |
| B9 | Translate spoiler section (heading, button, description) | `app/page.tsx` |

### Fix in first patch (🟡 Important — 24 items)

- Add rate limiting to Fever + GReader APIs
- Add HEALTHCHECK to Dockerfile
- Add HSTS header
- Document `DISABLE_BACKGROUND_SYNC` + `BACKGROUND_SYNC_INTERVAL_MINUTES` in `.env.example`
- Pin `prisma` CLI to exact same version as `@prisma/client`
- Add remaining DB indexes (Feed.categoryId, Category.parentId, Notification.feedId, Article.spoilerRuleId)
- Add `@@index([userId])` to Session model
- Translate 30+ toast strings in `server-management-dialog.tsx`
- Translate fallback strings ("Unknown", "Feed", "Label", "Saved Search") in `app/page.tsx`
- Translate ARIA labels + search placeholder in `app/page.tsx`
- Translate alert help text in `feed-management.tsx`
- Replace `confirm()` with `<AlertDialog>` in server-management-dialog
- Fix "All Articles" sentinel / capitalisation consistency
- Add `aria-label` to collapsed sidebar icon buttons
- Encrypt `twoFactorSecret` at rest
- Fix `deleteAccount.typeToConfirm` German text (oe → ö)
- Eliminate `as any` casts (worst offenders: `app/page.tsx`, `feed-management.tsx`)
- Replace bare `.catch(console.error)` calls with `logger.error()`
- Add enum validation to push subscribe endpoint
- Prevent email enumeration on `/api/register`
- Clean up `migration 2.sql` dead files
- Add pnpm version spec to `pwa.yml`

---

*This document should be deleted or archived once all blockers are resolved and v1.1.0 is tagged.*
