# Google Reader API Compatibility

FeedFerret exposes a Google Reader-style API. The contracts below target FreshRSS-compatible clients; installed native-client interoperability has not yet been certified.

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
| `s` | Stream ID (reading-list, starred, numeric feed ID or legacy feed URL, label) |
| `n` | Page size (default 20; positive sizes have no artificial maximum; zero/negative = unlimited, as FreshRSS) |
| `c` | Continuation token for pagination |
| `it` | Include state filter (e.g. `user/-/state/com.google/read`) |
| `xt` | Exclude state filter |
| `ot` | Oldest timestamp (Unix seconds): discovery >= ot OR modification >= ot |
| `nt` | Newest timestamp (Unix seconds): discovery <= nt AND modification <= nt |
| `r` | Sort order: `o` = oldest first; default is newest first |

The `POST stream/items/contents` body uses `application/x-www-form-urlencoded` with one or more `i=<itemId>` fields. `stream/items/ids` returns decimal numeric strings. Contents use `tag:google.com,2005:reader/item/<16-hex>`; both forms and legacy FeedFerret CUID references are accepted.

Supported stream targets:

- `user/-/state/com.google/reading-list` — articles from category/main/important feeds
- `user/-/state/com.google/starred` — starred articles
- `user/-/state/com.google/read` — read articles
- `feed/<numeric-id>` — specific feed (legacy `feed/<url>` also accepted)
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

## Client compatibility matrix

Use `https://your-feedferret-host/api/greader` with a **Google Reader compatible** account adapter and FeedFerret email/password. Feedbin and Feedly use separate protocols.

| Client target | Contract coverage | Native-client status |
|---|---|---|
| Reeder Classic, FeedMe | IDs → repeated POST `i`, full summary, state edits | Protocol contracts tested; native app release not certified |
| Read You, Fluent Reader, ReadKit | Stream filters, delta bounds, ordering, continuation | Not certified; verify the app's selected protocol/version |
| NetNewsWire | No supported FreshRSS/GReader adapter established | Unsupported/unverified; Feedbin support does not imply GReader support |

`tests/greader/sync.test.ts` replays recorded-style URL-encoded requests against a disposable SQLite DB without network calls. Fixtures model FreshRSS source behavior, not captures from installed clients.

Reference baseline: [FreshRSS a24ff145 GReader API](https://github.com/FreshRSS/FreshRSS/blob/a24ff145cd5a8a23235aaf3ad69f8abedf465530/p/api/greader.php), [EntryDAO](https://github.com/FreshRSS/FreshRSS/blob/a24ff145cd5a8a23235aaf3ad69f8abedf465530/app/Models/EntryDAO.php), and [item serializer](https://github.com/FreshRSS/FreshRSS/blob/a24ff145cd5a8a23235aaf3ad69f8abedf465530/app/Models/Entry.php).

## FeedFerret mapping rules

- Google Reader "folders" map to FeedFerret categories and appear in `tag/list`, `unread-count`, stream contents, and subscription metadata.
- Google Reader labels map to FeedFerret article labels.
- Reading list includes category/main/important feeds; feed-only and hidden priorities require explicit feed access. `org.freshrss/main` includes main/important feeds; `org.freshrss/important` includes important feeds. Explicit feed streams can access hidden feeds.
- Unread, read, starred, folder/label and feed targets combine with repeated `it`/`xt` filters using AND. Unknown targets return no items.
- Read/starred states map directly to FeedFerret article flags.
- Article/feed identities persist independently of CUIDs; decimal references and Google hex contents round-trip without `Number` conversion. See [numeric identity deployment details](numeric-api-ids.md) for startup backfill, Fever contracts and remaining timestamp limitations.
- Ordering uses discovery (`createdAt`) plus ID, not publication. Continuations preserve a discovery high-water mark and use direction-aware keyset comparisons. Items arriving after that mark appear in the next sync. Changes to stream membership during pagination are not a database snapshot.
- `ot` also includes modified older articles; `nt` bounds both discovery and modification. FeedFerret uses its combined `updatedAt` clock because it has no separate FreshRSS `lastModified` field.
- Bulk read `ts` compares discovery in microseconds, including the cutoff; invalid cutoffs are rejected.
- Full readable HTML (rendered from Markdown where needed) is supplied in both `summary.content` and `content.content`. Origin uses the feed website, and timestamps use discovery. RSS enclosures are retained on fetch and emitted as FreshRSS `enclosure` arrays; old rows need a feed refresh to populate metadata.

## Unread counts

`unread-count` returns discovery-based `newestItemTimestampUsec` values (Unix microseconds), including the newest read article, for:

- The global reading list
- The starred stream
- Each visible feed and folder/article-label union (same-name scopes are counted once)

`max` reflects the actual reading-list unread total; counts are not truncated to 1,000.

## Known limitations

- Each FeedFerret feed belongs to one category — assigning a second folder tag via `subscription/edit` replaces the current category.
- No content creation/social features (`broadcast`, `like`) — these tags are accepted and silently ignored.
- OPML import/export is available via the FeedFerret web UI; clients that rely on a GReader `opml` endpoint should use the web UI instead.

FreshRSS compat mode uses `summary`; FeedFerret additionally retains `content` and `updated` for existing consumers. `alternate` omits the MIME type as FreshRSS compat mode does. Content is not truncated.
