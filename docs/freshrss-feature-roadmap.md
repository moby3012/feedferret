# FreshRSS Feature Roadmap for FeedFerret

This document lists FreshRSS-style capabilities that FeedFerret could adopt next. Items are sorted by estimated implementation effort and practical product value.

## Low Effort

### 1. Keyboard Shortcut Help Overlay
FreshRSS exposes many fast reading actions. FeedFerret already has shortcuts, but users need discoverability.

- Add `?` shortcut overlay.
- List existing keys: `/`, `j`, `k`, `s`, `m`, `o`, `r`.
- Add quick actions for next unread, previous unread, open original, save search.

### 2. Per-Feed Quick Actions Menu
FreshRSS has feed-level actions from the sidebar.

- Refresh one feed.
- Mark feed as read.
- Open feed website.
- Edit feed.
- Show feed health details.

### 3. Better Import/Export Options
FreshRSS can export selected feeds and richer backup formats.

- Select categories/feeds for OPML export.
- Export all user data as JSON.
- Show import duplicates and skipped feeds separately.

### 4. Feed Statistics Cards
FreshRSS exposes statistics per feed.

- Articles per feed.
- Unread trend.
- Last successful sync.
- Average articles/day.
- Error rate.

### 5. User Preferences for Reading Behaviour
FreshRSS allows reading options customization.

- Mark as read after delay setting.
- Open original by default setting.
- Default view mode setting.
- Reader width setting.
- Default article sort order.

## Medium Effort

### 6. Auto-Mark-as-Read Rules
FreshRSS can auto-mark articles as read via filters.

- Rule fields: feed/category/query/action.
- Query syntax reuse from Advanced Search.
- Actions: mark read, star, label.
- Preview matching articles before enabling.

### 7. Saved Search Sharing
FreshRSS can reshare selections as HTML/RSS/OPML.

- Public read-only saved-search page.
- RSS feed for saved search results.
- Optional tokenized/private links.

### 8. Feed Authentication and Fetch Options
FreshRSS supports feed credentials and request options.

- HTTP Basic Auth per feed.
- Custom User-Agent.
- Timeout per feed.
- SSL strict/ignore option.
- Redirect handling and max-size limit.

### 9. Improved Full-Text Extraction Settings
FreshRSS supports truncated-feed handling via CSS/XPath configuration.

- Per-feed CSS selector for article body.
- Per-feed remove selectors.
- Test extraction preview.
- Auto-fetch full text on sync.

### 10. Retention Policy UI Expansion
FreshRSS offers stronger archive/purge control.

- Keep minimum N articles per feed.
- Never delete starred/labelled articles.
- Purge unread only after separate age threshold.
- Dry-run purge report.

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

1. Keyboard shortcut help overlay.
2. Per-feed quick actions menu.
3. Auto-mark-as-read rules using existing advanced search parser.
4. Feed authentication/fetch options.
5. Full-text extraction selector preview.

These build directly on the features already implemented and bring FeedFerret much closer to FreshRSS without sacrificing the clean Apple-like UX.
