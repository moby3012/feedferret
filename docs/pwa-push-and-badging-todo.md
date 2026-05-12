# PWA Push Notifications & Badging TODO

This document tracks remaining PWA polish. Browser push notifications have been implemented; badge/offline/install-surface work remains best-effort and platform-dependent.

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

Implemented in the notifications/FreshRSS OPML work branch and documented in `README.md`:

- `PushSubscription` data model with one subscription per browser endpoint and cascade delete by user.
- VAPID environment variables and `pnpm run webpush:keys`.
- Settings UI for support status, enable/disable current device, test notification, frequency, feed filter, and private/title payloads.
- Authenticated APIs: `POST /api/push/subscribe`, `POST /api/push/unsubscribe`, `POST /api/push/test`, `GET/PATCH /api/push/status`.
- Service worker `push` and `notificationclick` handling with badge updates from `unreadCount` payloads where supported.
- Server sender in `lib/push.ts`, including automatic disable for expired 404/410 subscriptions.
- Sync integration in `lib/notifications.ts` for immediate/hourly/daily new-article notifications.
- Privacy defaults: private/generic payloads by default and explicit user-controlled browser permission flow.

Remaining push-adjacent follow-ups:

- Dedicated durable notification queue if multi-process delivery/retry semantics become necessary.
- More granular rule/search-triggered notification controls once Keyword Alerts exist.

## TODO: Better app badging

Current badge implementation is client-side and best-effort. A more complete version should:

1. Centralize unread count calculation in a shared hook.
2. Update badge after:
   - article read/unread toggle
   - sync completion
   - mark all read
   - push notification receipt
3. Clear badge on sign-out.
4. In service worker, call badge APIs when a push payload contains `unreadCount`:
   - `self.navigator.setAppBadge(count)` where supported
   - `self.navigator.clearAppBadge()` when count is zero
5. Keep graceful fallbacks because many browsers do not support app badges.

## TODO: PWA polish

- Add real manifest screenshots for install prompts/store surfaces:
  - mobile narrow screenshot
  - desktop wide screenshot
- Consider richer shortcuts once deep links exist:
  - `/ ?view=new`
  - `/ ?view=readlater`
  - `/settings`
- Add proper deep-link handling for shortcuts.
- Consider caching the app shell more aggressively after auth/offline behavior is designed.
- Add an offline mode for already cached articles only if content privacy and storage limits are addressed.
- Add automated Lighthouse/PWA checks to CI.

## Implementation update — 2026-05-11

Implemented in the notifications/FreshRSS OPML work branch:

- Push subscription data model and VAPID key generation.
- Authenticated push subscribe/unsubscribe/status/test APIs.
- Service worker `push` and `notificationclick` handlers.
- Settings UI for per-device enable/disable, test notification, frequency, feed filter, and title/privacy toggle.
- Sync integration: new articles can trigger immediate notifications; hourly/daily summaries are flushed during background sync.
- Badge updates from push payload unread counts remain best-effort.
