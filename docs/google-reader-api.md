# Google Reader API Compatibility

FeedFerret exposes a Google Reader-style API for native RSS clients such as Reeder, NetNewsWire, ReadKit, FeedMe, and similar apps.

## Authentication

Supported auth styles:

- `ClientLogin` style token exchange via `POST /api/greader/accounts/ClientLogin`
- `Authorization: GoogleLogin auth=<token>`
- `Authorization: Bearer <token>`
- HTTP Basic Auth using FeedFerret email/password credentials

## Implemented endpoints

### Session / account

- `POST /api/greader/accounts/ClientLogin`
- `GET /api/greader/reader/api/0/token`
- `GET /api/greader/reader/api/0/user-info`

### Streams / article retrieval

- `GET /api/greader/reader/api/0/stream/contents/...`
- `GET /api/greader/reader/api/0/stream/items/contents/...`
- `GET /api/greader/reader/api/0/stream/items/ids/...`
- `POST /api/greader/reader/api/0/stream/items/contents` — batch-fetch articles by ID list

Supported query parameters for stream endpoints:

| Param | Description |
|---|---|
| `s` | Stream ID (reading-list, starred, specific feed URL, label) |
| `n` | Page size (1–200, default 20) |
| `c` | Continuation token for pagination |
| `it` | Include state filter (e.g. `user/-/state/com.google/read`) |
| `xt` | Exclude state filter |
| `ot` | Older-than timestamp (Unix seconds) — only return articles before this time |
| `r` | Sort order: `o` = oldest first; default is newest first |

The `POST stream/items/contents` body uses `application/x-www-form-urlencoded` with one or more `i=<itemId>` fields. Item IDs use the `tag:feedferret,2026:article/<id>` format returned by `stream/items/ids`.

Supported stream targets:

- `user/-/state/com.google/reading-list` — all articles
- `user/-/state/com.google/starred` — starred articles
- `user/-/state/com.google/read` — read articles
- `feed/<url>` — specific feed
- `user/-/label/<name>` — user label or folder/category

### Metadata

- `GET /api/greader/reader/api/0/subscription/list`
- `GET /api/greader/reader/api/0/tag/list`
- `GET /api/greader/reader/api/0/unread-count`
- `GET /api/greader/reader/api/0/preference/list`
- `GET /api/greader/reader/api/0/stream/preferences`
- `GET /api/greader/reader/api/0/preference/stream/list`

### Mutations

- `POST /api/greader/reader/api/0/edit-tag`
  - mark read/unread
  - star/unstar
  - add/remove labels
- `POST /api/greader/reader/api/0/mark-all-as-read`
  - optional `ts` param (Unix microseconds) — only mark articles older than this cutoff as read
- `POST /api/greader/reader/api/0/subscription/quickadd`
- `POST /api/greader/reader/api/0/subscription/edit`
  - rename feed title (`t`)
  - assign/remove one FeedFerret category via label-style folder tags (`a`, `r`)
  - unsubscribe feed (`ac=unsubscribe`)
- `POST /api/greader/reader/api/0/preference/stream/set`
- `POST /api/greader/reader/api/0/preference/stream/delete`

## Client setup guides

### Base URL for all clients

```
https://your-feedferret-host/api/greader
```

Replace `your-feedferret-host` with your actual domain. Use your FeedFerret account email and password as credentials.

---

### Reeder (macOS / iOS)

1. Open Reeder → Accounts → Add account
2. Select **Google Reader** (or **Feedbin** / **Feedly** — they share the same API shape)
3. Server: `https://your-feedferret-host/api/greader`
4. Username: your FeedFerret email
5. Password: your FeedFerret password
6. Tap **Sign In**

**Known behavior:** Reeder sends `GET stream/items/ids` first, then `POST stream/items/contents` in batches of up to 20 items. Both endpoints are fully supported.

---

### NetNewsWire (macOS / iOS)

1. Open NetNewsWire → Preferences → Accounts → +
2. Select **BazQux** or **Feedbin** (NetNewsWire uses the Google Reader API underneath)
3. API URL / Server: `https://your-feedferret-host/api/greader`
4. Username: your FeedFerret email
5. Password: your FeedFerret password

**Known behavior:** NetNewsWire uses `mark-all-as-read` with a `ts` microsecond cutoff parameter. FeedFerret honors this to avoid marking freshly synced articles as read.

---

### FeedMe (Android)

1. Open FeedMe → Settings → Accounts → Add account
2. Select **Google Reader API compatible server**
3. Server URL: `https://your-feedferret-host/api/greader`
4. Username: your FeedFerret email
5. Password: your FeedFerret password
6. Tap **Login**

**Known behavior:** FeedMe can request articles sorted oldest-first via `r=o`. FeedFerret supports this ordering parameter.

---

### ReadKit (macOS)

1. Open ReadKit → Preferences → Accounts → +
2. Choose **Google Reader**
3. Server: `https://your-feedferret-host/api/greader`
4. Username: your FeedFerret email
5. Password: your FeedFerret password

**Known behavior:** ReadKit fetches `stream/items/ids` then batch-fetches content via `POST stream/items/contents`. Continuation tokens use a stable cursor so pagination survives concurrent syncs.

---

## FeedFerret mapping rules

- Google Reader "folders" map to FeedFerret categories and appear in `tag/list`, `unread-count`, stream contents, and subscription metadata.
- Google Reader labels map to FeedFerret article labels.
- Reading list = all articles.
- Read/starred states map directly to FeedFerret article flags.
- Item IDs use the scheme `tag:feedferret,2026:article/<uuid>`. Clients that expect pure integer IDs will display the full string — this is cosmetic and does not affect sync.

## Unread counts

`unread-count` returns real `newestItemTimestampUsec` values (Unix microseconds) for:

- The global reading list
- The starred stream
- Each individual feed

This ensures clients display correct "last updated" timestamps and know when to trigger a background sync.

## Known limitations

- No Fever API (supported natively only in older NetNewsWire versions; use the GReader path above instead).
- Each FeedFerret feed belongs to one category — assigning a second folder tag via `subscription/edit` replaces the current category.
- No content creation/social features (`broadcast`, `like`) — these tags are accepted and silently ignored.
- OPML import/export is available via the FeedFerret web UI; clients that rely on a GReader `opml` endpoint should use the web UI instead.
