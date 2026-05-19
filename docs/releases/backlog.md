# Small Features Backlog

Features that are defined well enough to implement but not yet assigned to a release version. Assignment happens at the start of each release planning cycle based on user demand and engineering capacity.

Effort scale: **S** < 1 day · **M** 1–3 days · **L** 1–2 weeks · **XL** 2+ weeks

---

| Feature | Description | Effort |
|---|---|---|
| **Saved Search Admin Policy** | Global kill-switch in Server Management to disable all public saved search shares instance-wide. Useful for single-user or private deployments where public share URLs are undesirable. | S |
| **Batch API Endpoints** | `POST /api/v1/articles/batch` accepting an array of article IDs and an action (`read`, `unread`, `star`, `unstar`, `label`). Reduces round-trips for clients syncing large read states. | S |
| **API Token Scopes** | Per-token scope selection: `read` / `write` / `admin` instead of the current all-or-nothing access. Token creation UI updated with a scope picker. `admin` scope gates user management and settings endpoints. | M |
| **WebSub / PubSubHubbub** | Subscribe to WebSub hubs declared in feed `<link rel="hub">` tags. Enables instant article delivery for feeds that advertise a hub, eliminating polling latency. Requires a public callback URL. | L |
| **Offline-First Mutations** | Queue mark-read and star actions in IndexedDB when the network is unavailable. Sync the queue on reconnect using a Service Worker background sync event. Requires no UI change — the actions appear to succeed immediately. | L |
| **Website Scraping Feeds** | Subscribe to any HTML page without an RSS feed. User provides a URL and a CSS or XPath selector targeting the list of items. FeedFerret polls the page, extracts items, and presents them as a synthetic feed. | L |
| **Team Shares / Collaboration** | Share a feed or category with another registered user on the same instance. The recipient sees the feed in read-only mode in their own sidebar. Requires a `SharedFeed` join table and invitation flow. | XL |
| **Native iOS / Android App** | Capacitor or React Native wrapper around the existing web UI. Enables push notifications via APNs/FCM, better offline support, and App Store presence. | XL |
| **Fever API Compatibility** | Implement the Fever API protocol alongside the existing Google Reader API. Targets NetNewsWire users and clients that support Fever but not Google Reader. | M |
| **Telegram Inline Buttons** | Add "Mark as read" and "Open" reply buttons to Telegram keyword alert messages using the Telegram Bot API inline keyboard. Requires a webhook-mode bot (polling already used for send; webhook mode needed for receiving button presses). | M |
| **`prefers-contrast: more` Support** | ✅ Done | S |
| **Accessibility Statement Page** | ✅ Done | S |
| **Tier 2 Categories (Nested)** | Allow 2–3 levels of nested categories (e.g. Tech → Frontend → React). The DB schema already supports `parentId` on Category. Work needed: UI tree rendering for multi-level nesting, property inheritance (e.g. `hideFromAllFeeds`, `updateFrequency`) cascades from parent → child categories, sidebar expansion for deep trees, OPML import/export for nested outlines. Consider max depth of 3 to avoid UI complexity. | L |
