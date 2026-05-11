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

### 13. Full Google Reader API Compatibility
Current FeedFerret implementation is a baseline. FreshRSS is broadly compatible with native clients.

- Stream item IDs and continuation tokens.
- Stream preferences.
- Subscription edit endpoints.
- Quick add feed endpoint.
- Tag edit/list completeness.
- Fever API compatibility as secondary target.

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

## Recommended Next Sprint (Sprint 2)

All Sprint 1 items are complete. Next priorities ordered by value/effort ratio:

1. **Saved Search Sharing** (#7) — Medium effort. Extends existing `SavedSearch` model. Unblocks RSS-feed-from-search use case.
2. **Full Google Reader API** (#13) — High effort. Enables native RSS clients (Reeder, NetNewsWire, FeedMe). Biggest adoption multiplier.
3. **Multi-Database / Postgres** (#15) — High effort. Required for production deployments at scale. Prisma already supports it.
4. **Advanced SSRF Security** (#18) — Very High effort. Critical before recommending multi-user public hosting.
