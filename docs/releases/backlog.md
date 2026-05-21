# Small Features Backlog

Features that are defined well enough to implement but not yet assigned to a release version. Assignment happens at the start of each release planning cycle based on user demand and engineering capacity.

Effort scale: **S** < 1 day · **M** 1–3 days · **L** 1–2 weeks · **XL** 2+ weeks

---

| Feature | Description | Effort | Target |
|---|---|---|---|
| **Saved Search Admin Policy** | ✅ Done in v1.1 | S | — |
| **Batch API Endpoints** | ✅ Done in v1.1 — `POST /api/v1/articles/batch` | S | — |
| **API Token Scopes** | ✅ Done in v1.1 — `read`/`write`/`admin` enforced | M | — |
| **`prefers-contrast: more` Support** | ✅ Done | S | — |
| **Accessibility Statement Page** | ✅ Done | S | — |
| **Fever API Compatibility** | Implement the Fever API protocol alongside Google Reader API. Targets NetNewsWire and other Fever clients. | M | v1.3 |
| **Telegram Inline Buttons** | "Mark as read" + "Open" reply buttons on Telegram alert messages via Bot API inline keyboard. Requires switching to webhook mode. | M | v1.3 |
| **Full Zod Schemas for Server Actions** | Replace ad-hoc validation in `app/actions/` with explicit `z.object()` schemas. No behaviour change — defensive hardening. | M | v1.3 |
| **Tier 2 Categories (Nested)** | Sidebar tree rendering, parent picker in Feed Management, setting inheritance, OPML nesting. DB schema (`parentId`) already ready. Max depth: 2. | L | v1.3 |
| **WebSub / PubSubHubbub** | Subscribe to WebSub hubs declared in feed `<link rel="hub">` tags. Requires a public callback URL. | L | backlog |
| **Offline-First Mutations** | Queue mark-read/star in IndexedDB; sync on reconnect via Service Worker background sync. | L | backlog |
| **Website Scraping Feeds** | Subscribe to any HTML page via CSS/XPath selector. | L | backlog |
| **Team Shares / Collaboration** | Share feeds/categories with other users on the same instance. Requires `SharedFeed` join table and invitation flow. | XL | backlog |
| **Native iOS / Android App** | Capacitor wrapper with APNs/FCM push notifications. | XL | v2.0 |
| **Podcast Feeds & Audio Player** | Podcast parsing, persistent audio player, episode queue, TTS. | XL | v2.0 |
