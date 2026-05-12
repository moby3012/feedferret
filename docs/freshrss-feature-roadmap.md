# FreshRSS Feature Roadmap for FeedFerret

This document lists FreshRSS-style capabilities that FeedFerret could adopt next. Items are sorted by estimated implementation effort and practical product value.

## Low Effort

### 1. Keyboard Shortcut Help Overlay ✅ Done
FreshRSS exposes many fast reading actions. FeedFerret already has shortcuts, but users need discoverability.

- Add `?` shortcut overlay. ✅
- List existing keys: `/`, `j`, `k`, `s`, `m`, `o`, `r`. ✅
- Add quick actions for next unread (`n`), previous unread (`p`), open original (`o`), save search (`Shift+S`), mark all read (`Shift+A`). ✅

### 2. Per-Feed Quick Actions Menu ✅ Done
FreshRSS has feed-level actions from the sidebar.

- Refresh one feed. ✅ (`refreshFeed` server action + sidebar dropdown)
- Mark feed as read. ✅ (reuses `markAllAsRead({feedId})`)
- Open feed website. ✅ (origin derived from feed URL)
- Edit feed. ✅ (opens Management → Feeds tab)
- Show feed health details. ✅ (opens Management → Health tab)

### 3. Better Import/Export Options ✅ Done
FreshRSS can export selected feeds and richer backup formats.

- Select categories/feeds for OPML export. ✅ (checkboxes in Import/Export tab, `exportOpml(selectedFeedIds?)` action)
- Export all user data as JSON. ✅ (`exportUserData` action + JSON Export button in Import/Export tab)
- Show import duplicates and skipped feeds separately. ✅ (import report now shows new/already-existed/errors separately with color badges)

### 4. Feed Statistics Cards ✅ Done
FreshRSS exposes statistics per feed.

- Articles per feed. ✅ (Health tab: articleCount)
- Unread count. ✅ (Health tab: unreadCount)
- Last successful sync. ✅ (Health tab: lastFetchedAt)
- Average articles/day. ✅ (Health tab: avgArticlesPerDay computed from oldest article date)
- Error rate. ✅ (Health tab: lastStatus + lastError display)

### 5. User Preferences for Reading Behaviour ✅ Done
FreshRSS allows reading options customization.

- Mark as read after delay setting. ✅ (`markReadAfterDelaySecs` User field + Settings select + wired into page.tsx timer)
- Open original by default setting. ✅ (`openOriginalByDefault` User field + Settings toggle + wired into article select)
- Default view mode setting. ✅ (`defaultViewMode` User field + Settings select + initializes viewMode on load)
- Reader width setting. ✅ (`readerWidth` User field + Settings select + wired into ArticleReader)
- Default article sort order. ✅ (`defaultArticleSort` User field + Settings select + wired into filteredArticles sort)

## Medium Effort

### 6. Auto-Mark-as-Read Rules ✅ Done
FreshRSS can auto-mark articles as read via filters.

- Rule fields: feed/category/query/action. ✅
- Query syntax reuse from Advanced Search (extracted to `lib/search.ts`). ✅
- Actions: mark read, star, label. ✅
- Preview matching articles before enabling. ✅
- Runs automatically after each sync (`syncUserFeeds` → `applyAutoReadRules`). ✅
- "Run now" button in Management → Rules tab. ✅

### 7. Saved Search Sharing
FreshRSS can reshare selections as HTML/RSS/OPML.

- Public read-only saved-search page.
- RSS feed for saved search results.
- Optional tokenized/private links.

### 8. Feed Authentication and Fetch Options ✅ Done
FreshRSS supports feed credentials and request options.

- HTTP Basic Auth per feed. ✅ (`authType`, `authUsername`, `authPassword` fields + FeedEditDialog Auth tab)
- Custom User-Agent. ✅ (`customUserAgent` field)
- Timeout per feed. ✅ (`fetchTimeoutSecs` field)
- SSL strict/ignore option. ✅ (`sslVerify` toggle)
- Max-size limit. ✅ (`maxSizeKb` field, truncates content)

### 9. Improved Full-Text Extraction Settings ✅ Done
FreshRSS supports truncated-feed handling via CSS/XPath configuration.

- Per-feed CSS selector for article body. ✅ (`fullTextSelector` field)
- Per-feed remove selectors. ✅ (`fullTextRemoveSelectors` comma-separated)
- Test extraction preview. ✅ (`previewFeedExtraction` action + FeedEditDialog Full-Text tab)
- Auto-fetch full text on sync. ✅ (`autoFetchFullText` toggle, runs after each sync)

### 10. Retention Policy UI Expansion ✅ Done
FreshRSS offers stronger archive/purge control.

- Keep minimum N articles per feed. ✅ (`keepMinArticles` Feed field + inline input in Feeds tab)
- Never delete starred/labelled articles. ✅ (`isStarred: false, labels: { none: {} }` in retention query)
- Dry-run purge report. ✅ (`applyRetentionPolicies(dryRun)` + "Dry run" button in Health tab)

## High Effort

### 11. Website Scraping Feeds
FreshRSS can create feeds from websites without RSS.

- HTML + CSS selector/XPath source type.
- JSON dotted-path source type.
- Item selector, title selector, link selector, date selector.
- Preview discovered items.
- Store scraper definitions per feed.

### 12. WebSub / PubSubHubbub
FreshRSS supports instant push updates for compatible feeds.

- Discover hub links in Atom/RSS.
- Subscribe/unsubscribe lifecycle.
- Public callback endpoint.
- Signature verification.
- Lease renewal scheduler.

### 13. Full Google Reader API Compatibility ✅ Expanded
FeedFerret now provides a substantially more complete Google Reader-style API for native clients.

Implemented:

- Stream item IDs and continuation tokens. ✅
- Stream contents + item refs endpoints. ✅
- Stream preferences endpoint stub for compatibility. ✅
- Subscription edit endpoints. ✅
- Quick add feed endpoint. ✅
- Tag edit/list completeness. ✅
- Read/starred/label mapping. ✅
- Feed/category subscription metadata. ✅

Still open:

- Fever API compatibility as secondary target.
- True preference persistence, not just compatibility stubs.
- Broader client-by-client validation against Reeder / NetNewsWire / FeedMe.

### 14. Extension System
FreshRSS supports user/system extensions.

- Extension manifest format.
- Server-side hook points: sync, article ingest, render, action menu.
- UI slot hooks.
- Safe enable/disable per user/admin.

### 15. Multi-Database / Production Storage Options
FreshRSS supports SQLite, MySQL/MariaDB, PostgreSQL.

- Keep Prisma provider strategy documented.
- Add Postgres production profile.
- Migration workflow.
- Backup/restore commands.

## Very High Effort

### 16. Offline-First Native-Like PWA
FreshRSS works well on mobile browser; FeedFerret could go further.

- IndexedDB article cache.
- Offline reading queue.
- Background sync when app reopens.
- Push notifications for selected feeds.

### 17. Multi-User Shared/Anonymous Reading Mode
FreshRSS has anonymous/default-user modes.

- Public read-only collections.
- Shared saved searches.
- Public OPML/RSS exports.
- Admin controls for anonymous access.

### 18. Advanced Security for Server-Side Fetching
FreshRSS documents SSRF risk. FeedFerret should add first-class mitigations.

- Block private IP ranges by default in multi-user mode.
- DNS rebinding protection.
- Max response size.
- Protocol allowlist.
- Admin override per trusted deployment.

## Recommended Next Sprint

1. ~~Keyboard shortcut help overlay.~~ ✅ Done
2. ~~Per-feed quick actions menu.~~ ✅ Done
3. ~~Auto-mark-as-read rules using existing advanced search parser.~~ ✅ Done
4. ~~Feed authentication/fetch options.~~ ✅ Done
5. ~~Full-text extraction selector preview.~~ ✅ Done
6. ~~Retention policy UI expansion.~~ ✅ Done
7. ~~Dynamic theming (accent + secondary color pickers in Settings, applied via CSS vars).~~ ✅ Done

These build directly on the features already implemented and bring FeedFerret much closer to FreshRSS without sacrificing the clean Apple-like UX.

## Current Open Priorities

Sprint 1 and the Saved Search Sharing / Google Reader API Phase 1 work are complete. Next priorities ordered by value/effort ratio:

1. **External client verification** (#13 follow-up) — test Reeder, NetNewsWire, FeedMe against a deployed instance and tune client-specific GReader quirks.
2. **Duplicate Detection** — Medium effort. Hide or badge repeated articles across feeds.
3. **Outbound Webhooks** — Medium effort. Useful for n8n/Zapier/custom automation.
4. **Feed Discovery** — High effort. Related feeds and starter OPML packs.

Recently completed: **Advanced SSRF Security**, **Multi-Database / Postgres support**, **Keyword Monitoring & Alerts** with in-app notifications and optional browser push.

## Saved Search Sharing Implementation Notes

Status: ✅ Implemented.

Implemented scope:

- Saved searches can be toggled into a shared state from Manage Feeds → Saved Searches.
- Sharing creates an opaque token (`shareToken`) instead of exposing internal saved-search IDs.
- Shared read-only HTML page: `/shared/search/[token]`.
- Shared RSS feed: `/api/shared-search/[token]/rss`.
- Users can copy/open the public page and RSS URL from the saved-search card.
- Disabling sharing clears the token and immediately invalidates previously shared URLs.

Follow-up ideas:

- Add optional per-share title/description overrides.
- Add expiry dates for temporary shares.
- Add share analytics/counts.
- Add OPML export for a shared saved search if useful.
- Add authenticated-only team shares if FeedFerret grows collaboration features.

## Implementation update — FreshRSS Extended OPML + Notifications

Status: implemented on branch `feat/notifications-freshrss-opml`.

- FreshRSS extended OPML parser/exporter with `frss:*` attributes.
- Import/export mapping for priority, unicity criteria, scraper config, cURL-style HTTP options, full-content selectors, and dynamic OPML URLs.
- New feed source support: RSS/Atom, JSONFeed, JSON+DotNotation, HTML+XPath, XML+XPath, HTML+XPath+JSON+DotNotation.
- FreshRSS-style dynamic OPML categories sync automatically and use SSRF protections.
- Browser/PWA push notifications added with user-controlled frequency and article-title payloads by default.
