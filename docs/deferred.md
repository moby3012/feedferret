# Deferred Features & Known Limitations

This document lists features that were **explicitly considered but not implemented** in v1.1, along with the reason for deferral and the planned target version. It also documents known bugs that are not yet fixed.

---

## Deferred to v1.2

### Finger-Synced Swipe Animations

**Request:** Swipe animations (article view: next/prev article; sidebar: next/prev feed) should follow the finger in real time, not just trigger a fixed-duration transition after lift.

**Why deferred:** Requires implementing a gesture-tracking layer (pointer events + `translate3d` binding), spring physics for momentum/snap, and careful integration with the existing React state machine for navigation. Risk of breaking existing swipe detection on touch devices. Estimated effort: L (1–2 weeks).

**Target:** v1.2 — Theming & Layout release will include a full animation system audit.

---

### Swipe-Down in Feed Column Marks All as Read

**Request:** When swiping down past the top of the feed list (pull-to-next), all articles in the current view should be marked as read. Hidden feeds/categories must NOT be affected.

**Why deferred:** The edge-case logic is complex: in "All Articles" view, feeds marked `hideFromAllFeeds` and categories marked similarly must be excluded from the mark-all operation. The swipe gesture itself needs disambiguation (pull-to-refresh vs pull-to-mark-read). Medium effort with significant risk.

**Target:** v1.2 backlog.

---

### Desktop Swipe / Mouse Drag for Feed Navigation

**Request:** Swipe to the next/previous feed on desktop (using mouse drag or trackpad).

**Why deferred:** Touch events don't fire on desktop. Implementing pointer-event-based drag detection that is distinguishable from text selection, scrolling, and click requires careful threshold tuning and is prone to regressions on different input devices.

**Target:** v1.2 backlog.

---

### Multi-Level Categories (Nested)

**Status:** The database schema already supports nesting (`Category.parentId`, `parent`, `children` relations, `@@unique([userId, name, parentId])`).

**What's missing:**
- Sidebar tree rendering (expand/collapse nested categories)
- Feed Management UI for assigning a category to a parent
- Setting inheritance: `hideFromAllFeeds`, `updateFrequency`, `spoilerMode` cascading parent → child
- OPML import/export for `<outline>` nesting
- Sidebar unread aggregation across a subtree

**Why deferred:** L effort. The schema is ready — UI and logic work is the bottleneck.

**Target:** v1.2 Theming & Layout, or a dedicated v1.3 category release.

---

### PWA Background Badge Updates Without Open App

**Request:** The badge count on the PWA icon should update even when the app is not open.

**Why deferred:** Requires the [Periodic Background Sync API](https://developer.mozilla.org/en-US/docs/Web/API/Web_Periodic_Background_Sync_API), which is only available in Chrome on Android and requires HTTPS + service worker. The `navigator.setAppBadge()` call must happen inside a service worker sync handler. Significant service worker architecture change.

**Workaround:** Badge updates correctly whenever the app tab is active or reopened.

**Target:** v1.3 or a dedicated PWA enhancement sprint.

---

### AI Summary: Auto-Save on First Generation

**Status:** Already implemented. `app/actions/feeds.ts` saves `Article.aiSummary` and `Article.aiSummarizedAt` on every generation. The reader displays `localSummary ?? article.aiSummary` — the stored summary is shown on next visit without re-generating. No action needed.

---

### "All Articles" Unread Count Excluding Hidden Feeds

**Status:** Already fixed. `components/rss-sidebar.tsx` (line 324–325) filters out feeds with `hideFromAllFeeds` and categories with `hideFromAllFeeds` before summing `unreadCount`. No action needed.

---

## Known Bugs / Open Issues

### German Native-Speaker Review

All German translations were produced without a native-speaker review pass. Machine-assisted translation may contain unnatural phrasing, incorrect case (Dativ/Akkusativ), or compound noun errors. A community review PR is welcome — see `docs/contributing-translations.md`.

### Date/Time Formatting Not Yet via next-intl

Some date strings still use `toLocaleString()` / `toLocaleDateString()` directly (e.g., article publish dates in the reader, shared search page). These should use next-intl's `useFormatter` or `format.dateTime()` for consistent locale-aware output (e.g., German: `12.05.2026`, not `5/12/2026`). Tracked for v1.2.

### RTL: Swipe Gesture Direction

Under `dir="rtl"`, swipe-left and swipe-right navigation gestures are not inverted. A user expecting RTL swipe conventions will find the direction backwards. Tracked for v1.2 alongside the gesture animation work.

### Token `admin` Scope Not Enforced on Admin Actions

The `admin` scope is defined and selectable in the UI, but no endpoints currently require it — all write operations accept `write` scope. Admin-level operations (e.g., sync triggers, server settings) currently accept `write`. This will be tightened in a follow-up once the admin endpoint surface is fully defined.

---

## Not in Scope (Indefinitely)

| Feature | Reason |
|---|---|
| Machine-translation CI pipeline (DeepL auto-suggestions in PRs) | Requires paid API key in CI; quality risk |
| Per-feed language override for content display | Low demand; complex interaction with i18n routing |
| Translated AI summary prompts | Prompt engineering effort; stays English for now |
| In-app translation editor UI | Third-party tools (Weblate, Lokalise) are better suited |
| WebSub / PubSubHubbub | Requires public callback URL; not self-hosting friendly |
| Offline-First Mutations (IndexedDB queue) | Service worker complexity; low priority vs other work |
| Website Scraping Feeds (CSS/XPath selectors) | Maintenance burden; legal grey area |
| Team Shares / Collaboration | Requires invitation flow, XL effort |
| Native iOS/Android App | Capacitor/RN wrapper; separate project scope |
| Fever API Compatibility | Low demand since Google Reader API covers most clients |
