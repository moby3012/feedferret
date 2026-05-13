# PWA Push Notifications & Badging Status

This document tracks PWA push, badging, and polish status. Browser push, centralized badge updates, manifest screenshots, deep links, Lighthouse CI checks, and a cached-article offline fallback are implemented; all badge behavior remains best-effort because browser support differs. Open follow-ups have moved to the ordered backlog in `docs/next-session-workpackages.md`. Open follow-ups have moved to the ordered backlog in `docs/next-session-workpackages.md`.

## Already done

- Web app manifest exists and now includes:
  - `id`
  - `scope`
  - `display_override`
  - app categories
  - basic app shortcuts
- Installability metadata/icons exist, including maskable icons.
- Add-to-Home-Screen first-run prompt exists for mobile users.
- The prompt is remembered in `localStorage` after dismissal.
- Settings contain an explicit “Add to Home Screen” entry that can re-open install instructions.
- A lightweight service worker is registered for same-origin PWA support.
- A basic offline fallback page exists for navigations while offline.
- Client-side app badge updates are attempted via the Badging API when supported.

## Platform reality check

### Push notifications

Push is possible, but support differs:

- Android Chrome/Edge: good support.
- Desktop Chrome/Edge/Firefox/Safari: generally available with differences.
- iOS/iPadOS: requires iOS 16.4+ and the site must be installed to the Home Screen as a PWA before Web Push can work.
- Users can deny permission permanently until they change browser/site settings.

### App icon badges

Badges are best-effort:

- Chromium-based browsers support `navigator.setAppBadge(count)` and `navigator.clearAppBadge()`.
- iOS PWA badge behavior is less reliable and often tied to push notification permission/platform behavior.
- Firefox support is limited.
- Therefore the app must always keep in-app unread counts as the source of truth and treat icon badges as a progressive enhancement.

## Push notifications ✅ Implemented

Implemented in the notifications/Scout Studio OPML work branch and documented in `README.md`:

- `PushSubscription` data model with one subscription per browser endpoint and cascade delete by user.
- VAPID environment variables and `pnpm run webpush:keys`.
- Settings UI for support status, enable/disable current device, test notification, frequency, feed filter, and private/title payloads.
- Authenticated APIs: `POST /api/push/subscribe`, `POST /api/push/unsubscribe`, `POST /api/push/test`, `GET/PATCH /api/push/status`.
- Service worker `push` and `notificationclick` handling with badge updates from `unreadCount` payloads where supported.
- Server sender in `lib/push.ts`, including automatic disable for expired 404/410 subscriptions.
- Sync integration in `lib/notifications.ts` for immediate/hourly/daily new-article notifications.
- Privacy defaults: private/generic payloads by default and explicit user-controlled browser permission flow.

Remaining push-adjacent follow-ups are tracked in the ordered backlog:

- Dedicated durable notification queue if multi-process delivery/retry semantics become necessary.
- Keyword Alert follow-ups now live in `docs/next-session-workpackages.md`.

## Better app badging ✅ Implemented

Current badge implementation remains best-effort because browser support differs, but the FeedFerret logic is now centralized:

1. [x] Unread count calculation lives in `hooks/use-app-badge.ts`.
2. [x] App badge updates when the shared feed unread count changes, covering read/unread toggles, sync completion, and mark-all-read invalidations.
3. [x] Badge is cleared when the app is not authenticated/enabled.
4. [x] Service worker updates badges from push payload `unreadCount` and accepts `SET_BADGE`/`CLEAR_BADGE` messages from the app.
5. [x] Badge calls remain wrapped as progressive enhancement with graceful fallbacks.

## PWA polish ✅ Implemented

- [x] Added manifest screenshots for install prompts/store surfaces:
  - mobile narrow screenshot: `/screenshots/mobile-narrow.svg`
  - desktop wide screenshot: `/screenshots/desktop-wide.svg`
- [x] Added richer shortcuts:
  - `/?view=new`
  - `/?view=readlater`
  - `/?view=starred`
  - `/settings`
- [x] Added proper deep-link handling for shortcuts and notification links:
  - `view=new|readlater|starred|all`
  - `article=<id>`
- [x] Service worker now caches runtime app shell assets with stale-while-revalidate.
- [x] Added optional offline mode for already cached articles via a local device snapshot of recent articles.
- [x] Added automated PWA checks and Lighthouse CI workflow:
  - `pnpm run pwa:check`
  - `.github/workflows/pwa.yml`

## Implementation update — 2026-05-11

Implemented in the notifications/Scout Studio OPML work branch:

- Push subscription data model and VAPID key generation.
- Authenticated push subscribe/unsubscribe/status/test APIs.
- Service worker `push` and `notificationclick` handlers.
- Settings UI for per-device enable/disable, test notification, frequency, feed filter, and title/privacy toggle.
- Sync integration: new articles can trigger immediate notifications; hourly/daily summaries are flushed during background sync.
- Badge updates from push payload unread counts remain best-effort.
