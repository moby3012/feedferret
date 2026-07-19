# FeedFerret — Patch Notes · 2026-07-15

A large post-v1.1.1 maintenance day: a full four-domain design audit (security, performance, UX, visuals) was run and **all 54 findings resolved**, plus the documentation was brought back up to date. Everything below is merged to `main` and tracked in the [CHANGELOG](../../CHANGELOG.md) "Unreleased" section, targeting **v1.2**.

> **Merged PRs:** #98 (docs) · #99 (security) · #100 (performance) · #101 (UX) · #102 (visuals) · #103 (audit close-out) · #104 (FTS search) · #105 (list perf) · #106 (unsaved-changes) · #107 (design system)

---

## 🔒 Security

- **SSRF hardening.** Auto-read-rule **webhooks**, **Gotify/Ntfy** notification channels, and per-user **Ollama** endpoints now go through the same protection used for feed fetching (blocks localhost / private / link-local addresses, re-checked at send time). Previously a signed-in user could make the server reach internal services or cloud-metadata endpoints. *→ Note: a default local Ollama (`http://localhost:11434`) now requires the admin to explicitly allow internal fetching.*
- **Telegram "mark read" links** are now signed with `AUTH_SECRET` and verified in constant time. The old code used a variable this app never sets, so a guessable constant was always the signing key — forged links could flip read/unread on other users' articles. It now fails closed if the secret is missing.
- **Sign-up hardening.** `/api/register` is now rate-limited and input-validated (email format, password length). Registration flooding and password-hash CPU abuse are shut down.
- **Smaller fixes:** constant-time internal-API-key check, web-push endpoint validation, category-ownership check before linking a feed, and an audit-log note when an admin disables SMTP certificate verification.

## ⚡ Performance

- **Much faster feed sync.** The per-article database loop (up to ~3 round-trips per article) was replaced with a batched insert/update path — same de-duplication behavior, far fewer queries. Covered by 8 new tests.
- **Conditional GET.** Feeds are only re-downloaded when they've actually changed (`If-None-Match` / `If-Modified-Since`), saving bandwidth and CPU on every sync cycle.
- **Indexed full-text search.** Free-text search is no longer a slow full-table scan: SQLite uses an FTS5 index (substring-compatible, so results are unchanged), PostgreSQL uses `pg_trgm`. Setup is automatic and safe on startup, with a fallback so results are never worse than before.
- **Lighter long lists.** Long article lists use `content-visibility` + lazy images to cut layout/paint cost, with no change to scrolling or gestures.
- **Automatic retention.** Article retention (`defaultRetentionDays` / per-feed limits) now runs on its own daily instead of only when triggered manually — the article table no longer grows unbounded.
- **Smaller fixes:** de-duplicated GReader bulk tag edits, parallelized dynamic-OPML sync, added missing indexes, trimmed list-view payloads (which also stops sending internal feed credentials to the browser), and capped the in-memory rate-limit store.

## ✨ User Experience

- **Toasts actually work now.** The toast component was never mounted, so every "Saved", "Failed", etc. notification across the app had been silently doing nothing. It's now mounted (and positioned clear of the mobile bottom bar).
- **Undo for accidental mark-all-read.** Swiping to the next feed (which auto-marks the current one read) now shows an **Undo** toast.
- **Unsaved-changes warning.** Closing the feed-edit dialog with unsaved edits now asks before discarding. Saving still closes cleanly.
- **Sync failures are visible.** A failed background sync now surfaces a toast instead of failing silently.
- **Delete-account fix.** The confirmation phrase now matches the translated placeholder, so non-English users can actually complete it.
- **Polish:** full internationalization of the search modal / spoiler gate / offline banner, proper pluralization of result counts, a spinner during full-text fetch, an error state for AI summaries, and added ARIA labels/states on disclosures, the sidebar toggle, and the category chevron.

## 🎨 Visual & Theming

- **Auth pages fixed for light mode.** Login, register and setup were hardcoded to a dark palette and were unusable in light mode — they now use the theme tokens and render correctly in both.
- **Keyboard focus restored.** Inputs and nav links that had their focus ring removed now show a visible focus state again (WCAG 2.4.7).
- **Theme-safe details:** toggle-switch knobs, loading spinners, feed-name badges and the theme-color logic no longer use hardcoded black/white, and the active sidebar item is more clearly highlighted.
- **Design system documented.** A new [`docs/design-system.md`](../design-system.md) codifies the radius scale, icon-size scale, and Dialog/AlertDialog conventions so future work stays consistent.

---

## Notes for self-hosters

- **Ollama users:** if you use a local Ollama for AI summaries, set the admin "allow internal fetching" option (or the corresponding env flag) — otherwise `localhost` requests are now blocked by the SSRF guard.
- **PostgreSQL full-text search:** the `pg_trgm` extension is created automatically at startup **if** the database role has permission. On restricted managed Postgres it will simply log a warning and search stays functional (just unaccelerated).
- No manual migration steps are required — schema changes apply via the normal `prisma db push` on startup.

## For maintainers — recommended manual smoke tests

These couldn't be verified in a headless environment:

- **PostgreSQL:** confirm `CREATE EXTENSION pg_trgm` succeeds (or degrades gracefully) on your instance.
- **Long lists:** scroll list / minimal / magazine modes and confirm rows render on scroll-in, scroll-restore lands correctly, read-on-scroll fires, and swipe/overscroll gestures still work.
- **Feed-edit dialog:** confirm the discard prompt appears on backdrop/Escape/X/Cancel with edits, and that Save closes without it.

---

*See [`docs/archive/design-audit-todo.md`](../archive/design-audit-todo.md) for the full 54-item audit with per-finding detail and PR links, and the [CHANGELOG](../../CHANGELOG.md) for the canonical change list.*
