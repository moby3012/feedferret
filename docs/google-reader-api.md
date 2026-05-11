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

Supported query parameters:

- `s` / stream path suffix for stream selection
- `n` for page size
- `c` for continuation token
- `it` include state filters
- `xt` exclude state filters

Supported stream targets:

- reading list
- starred
- read
- specific feed (`feed/<url>`)
- user label (`user/-/label/<name>`)

### Metadata

- `GET /api/greader/reader/api/0/subscription/list`
- `GET /api/greader/reader/api/0/tag/list`
- `GET /api/greader/reader/api/0/unread-count`
- `GET /api/greader/reader/api/0/preference/list`
- `GET /api/greader/reader/api/0/stream/preferences`

### Mutations

- `POST /api/greader/reader/api/0/edit-tag`
  - mark read/unread
  - star/unstar
  - add/remove labels
- `POST /api/greader/reader/api/0/mark-all-as-read`
- `POST /api/greader/reader/api/0/subscription/quickadd`
- `POST /api/greader/reader/api/0/subscription/edit`
  - rename feed title
  - assign/remove one FeedFerret category via label-style folder tags
  - unsubscribe feed

## FeedFerret mapping rules

- Google Reader “folders” are mapped onto FeedFerret categories.
- Google Reader labels are mapped onto FeedFerret article labels.
- Reading list corresponds to all articles.
- Read/starred states map directly to FeedFerret article flags.
- Shared/public saved searches are separate and not exposed as GReader streams yet.

## Important limitations

This is much more complete than the previous baseline, but still not perfect parity with the historical Google Reader API.

Known gaps:

- No Fever API.
- No true stream preferences persistence yet; preference endpoints currently return empty preference lists.
- Continuation is offset-based rather than stable cursor-based.
- Only one feed category/folder can exist at a time because FeedFerret feeds belong to one category.
- No full subscription export/edit parity for every legacy GReader client quirk.
- No content creation/social features (`broadcast`, `like`) beyond harmless metadata exposure.

## Recommended client setup

Most clients work with:

- Base URL: `https://your-host/api/greader`
- Username: FeedFerret account email
- Password: FeedFerret password

If a client expects Google Reader / BazQux / FreshRSS style endpoints, use the same base and let the client append `reader/api/0/...` paths.
