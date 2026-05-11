# PWA Push Notifications & Badging TODO

This document tracks the PWA work that is intentionally **not** finished yet because it needs backend, database, and permission-flow design.

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

## TODO: Push notifications

### 1. Data model

Add a table for push subscriptions, for example:

- `id`
- `userId`
- `endpoint`
- `p256dh`
- `auth`
- `userAgent`
- `platform`
- `createdAt`
- `updatedAt`
- `lastUsedAt`
- `disabledAt`

Important constraints:

- Unique by `endpoint`.
- Cascade/delete when user is deleted.
- Allow multiple subscriptions per user because users can install on multiple devices.

### 2. VAPID setup

Add environment variables:

- `WEB_PUSH_VAPID_PUBLIC_KEY`
- `WEB_PUSH_VAPID_PRIVATE_KEY`
- `WEB_PUSH_CONTACT` such as `mailto:admin@example.com`

Add a script to generate keys, e.g. `npm run webpush:keys`.

### 3. Client permission flow

Add a Settings section:

- “Push notifications”
- Status states:
  - Unsupported
  - Not installed as PWA on iOS
  - Not requested
  - Granted
  - Denied
- Buttons:
  - Enable notifications
  - Disable this device
  - Send test notification

Flow:

1. Check `Notification` and `serviceWorker` support.
2. Register/await service worker readiness.
3. Request permission only after a user click.
4. Subscribe via `registration.pushManager.subscribe()`.
5. Send subscription to backend.
6. Store subscription in DB.

### 4. API routes

Add authenticated routes:

- `POST /api/push/subscribe`
  - Saves/updates current browser subscription.
- `POST /api/push/unsubscribe`
  - Disables/deletes current endpoint.
- `POST /api/push/test`
  - Sends a test notification to the current user.
- Optional: `GET /api/push/status`
  - Returns whether the current user has active subscriptions.

### 5. Service worker push handling

Extend `public/sw.js` with:

- `push` event listener.
- `notificationclick` event listener.
- Badge update when payload contains unread count.
- Safe fallback notification title/body/icon.

Notification payload should include:

- `title`
- `body`
- `url`
- `articleId` or feed/category destination
- `unreadCount`
- `tag` for deduplication

### 6. Server-side sender

Add a server utility, e.g. `lib/push.ts`:

- Load VAPID config.
- Send notification to all active user subscriptions.
- Remove/disable expired subscriptions when push provider returns 404/410.
- Log non-fatal push errors.

Likely dependency:

- `web-push`
- `@types/web-push` for TypeScript

### 7. Notification trigger strategy

Decide product behavior before implementation:

- Notify on every new article? Risk: spam.
- Notify only for selected feeds? Better.
- Notify only for labels/searches/rules? Best long-term.
- Digest-style push summary? Good default.

Suggested first version:

- Add per-user setting: `pushEnabled`.
- Add per-user setting: `pushFrequency` = `off | immediate | hourly | daily`.
- Add optional per-feed enable list.
- Start with hourly summary: “12 new unread articles”.

### 8. Background job integration

Current sync/background systems need to call the push utility after new articles are stored.

Requirements:

- Detect newly created article IDs per user/feed.
- Avoid notifying for articles already known before subscription.
- Rate-limit notifications.
- Avoid duplicate sends across server restarts or repeated sync runs.

A dedicated notification queue table may be needed:

- `id`
- `userId`
- `articleId`
- `type`
- `status`
- `scheduledAt`
- `sentAt`
- `error`

### 9. Privacy/security

- Never expose another user’s articles in push payloads.
- Keep payload minimal; for private feeds maybe send generic “New articles available”.
- Do not request notification permission on first load.
- Provide clear disable controls.
- Document server contact in VAPID config.

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
