# Sprint 1 — Completed ✅

- [x] Keyboard shortcut help overlay (`?` key + full overlay)
- [x] Per-feed quick actions menu (refresh, mark read, edit, health)
- [x] Better import/export (selective OPML export, JSON export, import report with badges)
- [x] Feed statistics cards (article count, unread, last sync, avg/day, error rate)
- [x] User preferences for reading behaviour (delay, open-original, view mode, reader width, sort)
- [x] Auto-mark-as-read rules (query syntax, preview, run-now, auto-runs on sync)
- [x] Feed authentication + fetch options (Basic Auth, User-Agent, timeout, SSL, max-size)
- [x] Full-text extraction settings (CSS selectors, remove selectors, preview, auto-fetch)
- [x] Retention policy UI expansion (min articles, protect starred/labelled, dry-run)
- [x] Dynamic theming (accent + secondary color pickers, CSS vars)

---

# Sprint 2

## Saved Search Sharing (#7) — Medium Effort
- [ ] Public read-only saved-search page (tokenized URL)
- [ ] RSS feed endpoint for saved search results
- [ ] Optional private/tokenized links with share toggle in UI
- [ ] Admin control to enable/disable public sharing

## Full Google Reader API (#13) — High Effort
- [ ] Stream item IDs with continuation tokens (paging)
- [ ] Stream preferences endpoints
- [ ] Subscription edit endpoints (`/reader/api/0/subscription/edit`)
- [ ] Quick-add feed endpoint (`/reader/api/0/subscription/quickadd`)
- [ ] Tag list/edit completeness
- [ ] Test with Reeder / NetNewsWire
- [ ] (Stretch) Fever API compatibility

## Multi-Database / Postgres (#15) — High Effort
- [ ] Document Prisma provider swap (SQLite → Postgres)
- [ ] Add `DATABASE_PROVIDER` env var to docker-compose
- [ ] Add Postgres service to docker-compose.yml
- [ ] Test migration workflow on Postgres
- [ ] Document backup/restore commands

## Advanced SSRF Security (#18) — Very High Effort
- [ ] Block private IP ranges (RFC1918) in feed fetch by default
- [ ] DNS rebinding protection (resolve → recheck IP after DNS lookup)
- [ ] Protocol allowlist (http/https only)
- [ ] Max response size enforcement in fetcher
- [ ] Admin override: trusted-deployment mode to allow internal URLs
