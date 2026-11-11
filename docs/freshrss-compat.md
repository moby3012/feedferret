# FreshRSS OPML compatibility

FeedFerret reads and writes the [FreshRSS OPML extension](https://freshrss.github.io/FreshRSS/en/developers/OPML.html)
(namespace `https://freshrss.org/opml`). Semantics follow the FreshRSS sources
(`app/Services/ImportService.php`, `app/views/helpers/export/opml.phtml`,
`app/Models/Feed.php`), not only the spec page.

Code: `lib/opml.ts` (parse + export), `lib/import/opml-import.ts` (mapping, report),
`lib/dedupe-key.ts` (unicity), `lib/full-text-conditions.ts`, `lib/remove-selectors.ts`.
Tests: `tests/lib/opml-freshrss-compat.test.ts` (round trips, per-attribute, security),
fixtures in `tests/fixtures/freshrss/`.

## Prefix

FreshRSS' OPML library reads attributes by **qualified name** (`frss:cssFullContent`),
not by namespace URI. FeedFerret therefore exports with the literal prefix `frss:`.
Exports made before this change used `ffx:` (same namespace) and were silently ignored
by FreshRSS; they still import into FeedFerret. On import, any prefix bound to the
namespace is accepted, plus undeclared `frss:`/`ffx:` prefixes.

Line breaks inside attribute values (read filters, headers, conditions, multi-line
XPath) are written as `&#10;`/`&#13;`; a literal newline would be turned into a space
by every XML parser.

## Matrix

Legend — **Import**: what FeedFerret does with it from your own file (UI upload, REST,
MCP). **Remote** files — dynamic-OPML categories and GReader `subscription/import` —
are untrusted: see [Remote OPML](#remote-opml). **Export**: written back ("opt-in" =
only with *Include credentials*, see [Export variants](#export-variants)).
**Round trip**: FreshRSS → FeedFerret → FreshRSS gives the same value
(booleans compared as FreshRSS reads them, line lists as sets).

| Attribute | FeedFerret mapping | Import | Export | Round trip |
|---|---|---|---|---|
| `type` rss / HTML+XPath / XML+XPath / JSON+DotNotation / JSONFeed / HTML+XPath+JSON+DotNotation | `sourceType` | ✅ (`JSON+DotPath` → JSON+DotNotation, unknown → RSS, reported) | ✅ | ✅ |
| `frss:xPathItem` … `frss:xPathItemUid` (10) | `scraperConfig.xpath` | ✅ (❌ remote) | ✅ | ✅ |
| `frss:jsonItem` … `frss:jsonItemUid` (10), `frss:xPathToJson` | `scraperConfig.json`, `.xPathToJson` | ✅ (❌ remote) | ✅ | ✅ |
| `frss:priority` important / main / category | `priority`; category → `hideFromAllFeeds` | ✅ | ✅ (also: hidden-from-All-feeds → `category`) | ✅ |
| `frss:priority` feed / hidden | `priority` + `hideFromAllFeeds` | ⚠️ approximated (still listed in its category), reported | ✅ | ✅ |
| `frss:ttl` (s, negative = muted) | `updateFrequency` (5–10080 min), `autoMuted` | ✅; rounded/clamped values reported | ✅ signed; muted feeds without own interval use the account default | ✅ (original kept in `scraperConfig.preserved.ttl` while the interval is unchanged) |
| `frss:unicityCriteria` id / link / `sha1:*` (all 9) | `unicityCriteria` → article identity | ✅ — `sha1:*` = FreshRSS `decideEntryGuid(fallback: true)`: bare SHA-1 hex of the raw title ("" if none) / raw content, same fallback chain (guid → sha1(link·date) → sha1(link·date·title) → sha1(all)); see [parity gaps](#known-upstream-differences) | ✅ | ✅ |
| `frss:unicityCriteriaForced` | `unicityCriteriaForced` | ✅ (FeedFerret never degrades criteria, i.e. always behaves as forced) | ✅ | ✅ |
| `frss:cssFullContent` | `fullTextSelector`, `fullTextMode=selector` (never downgrades auto/ai) | ✅ (❌ remote) | ✅ while full text is on (in FreshRSS the selector *is* the switch) | ✅ |
| `frss:cssContentFilter` (+ legacy `frss:cssFullContentFilter`) | `fullTextRemoveSelectors` — removed from feed content **and** full text | ✅ (❌ remote) | ✅ | ✅ |
| `frss:cssFullContentConditions` | `fullTextConditions` — full text only for matching articles | ✅ (❌ remote); if a line is not translatable, full text for all articles, reported | ✅ | ✅ |
| `frss:filtersActionRead` plain word / `"phrase"` | keyword in `filtersActionRead` | ✅ | ✅ (quoted when FreshRSS would read it as syntax) | ✅ |
| `frss:filtersActionRead` `intitle:` `intext:` `author:` `inurl:`, `-x`, `OR` | feed-scoped auto-read rule | ✅ exact | ✅ original line | ✅ |
| `frss:filtersActionRead` other syntax (regex, `#tag`, `date:`, parentheses …) | — (inactive) | ❌ reported | ✅ original line | ✅ (kept in `scraperConfig.preserved`) |
| `frss:CURLOPT_USERAGENT`, `_FOLLOWLOCATION` | `httpOptions` / `customUserAgent` | ✅ (❌ remote) | ✅ | ✅ |
| `frss:CURLOPT_MAXREDIRS` | `httpOptions` (0–20, also enforced by the fetcher) | ✅; clamped values reported (❌ remote) | ✅ | ✅ within range |
| `frss:CURLOPT_COOKIE`, `_POST`, `_POSTFIELDS` | `httpOptions` | ✅ (❌ remote) | opt-in | ✅ with opt-in |
| `frss:CURLOPT_HTTPHEADER` | `httpOptions` | ✅; `Host`, framing/hop-by-hop headers dropped + reported (names only; the fetcher never sends them either) (❌ remote) | opt-in | ✅ with opt-in (minus dropped headers) |
| `frss:CURLOPT_PROXY` / `_PROXYTYPE` | `httpOptions` (HTTP/HTTPS proxy, scheme added) | ✅, same SSRF rules as feed URLs; SOCKS or internal → dropped, reported (❌ remote) | opt-in | ✅ with opt-in (proxy gains an explicit `http://`) |
| `frss:CURLOPT_COOKIEFILE` | — | ❌ reported (path on the FreshRSS server; FreshRSS itself only keeps `""`) | — | — |
| `frss:opmlUrl` (category) | `Category.opmlUrl` (dynamic OPML) | ✅ own file; ❌ nested in remote OPML | ✅ | ✅ |
| `category` attribute on a root feed | category by name | ✅ | — (feeds are nested instead) | ✅ structurally |
| empty categories | categories | ✅ | ✅ | ✅ |
| unknown `frss:*` | `scraperConfig.extensions` (inert) | stored, reported | opt-in | ✅ with opt-in |
| user:pass in `xmlUrl` / `htmlUrl` / `opmlUrl` | kept in the URL | ✅ | opt-in (stripped otherwise) | ✅ with opt-in |

Not part of the FreshRSS OPML format (so not exchanged): keep-history / max-items,
per-category refresh interval, FeedFerret-only reader settings. HTTP Basic auth lives
in the feed URL in FreshRSS; FeedFerret's separate Basic-auth fields are never exported.

## Security

### Remote OPML

Dynamic-OPML categories and GReader `subscription/import` are imported with
`trust: "remote"`: a third party controls the file, and FeedFerret is multi-user. From
such files FeedFerret accepts **no** selector or expression (`cssFullContent`,
`cssContentFilter`/`cssFullContentFilter`, `cssFullContentConditions`, `xPath*`,
`json*`, `xPathToJson` → `expression-remote-dropped`), **no** cURL option at all
(cookie, headers, POST, proxy, user agent, follow-location, max-redirects →
`http-option-remote-dropped`), no auto-read rules and no nested dynamic categories.
A remote sync never overwrites HTTP options of an existing feed.

### Where imported expressions run

| Expression | Evaluated in | Engine | Input bounds |
|---|---|---|---|
| `xPathItem*`, `xPathToJson` | `lib/feed-fetcher.ts` during feed sync | jsdom `XPathEvaluator`, **main thread** of the server process (background sync runs in-process, `instrumentation.ts`) | fetched document ≤ `maxSizeKb` (default 5 MB), fetch timeout 30 s |
| `jsonItem*` | `lib/feed-fetcher.ts` | plain dot/bracket path walk (no evaluation) | same |
| `cssFullContent` | `lib/rss-sync.ts` `autoFetchFullTextForArticles` | jsdom `querySelector`, main thread | page ≤ 2 MB, 12 s timeout, ≤ 5 redirects, ≤ 20 articles per feed sync |
| `cssContentFilter` | `lib/remove-selectors.ts` from `lib/rss-sync.ts` (feed items + full-text page) | jsdom `querySelectorAll`, main thread; invalid selector = no-op | feed body ≤ `maxSizeKb`; full-text page ≤ 2 MB |
| `cssFullContentConditions`, `filtersActionRead` | `lib/full-text-conditions.ts`, `lib/feed-content-filter.ts`, auto-read rules | translated to literal substring checks and FeedFerret search (DB queries); **no regex is ever executed** (regex lines are refused) | translated query ≤ `MAX_SEARCH_QUERY` |

**Pending #281** (bounded HTML parsing worker pool): until it is merged, selector and
XPath evaluation has no CPU time limit — a 15-character selector such as
`:has(* * * * *)` can take seconds on a crafted page. With #281 all of the above
(including the feed-content `removeSelectorsFromHtml`) moves to `runInHtmlWorker`, one
task per feed batch. Until then the exposure is limited to expressions the feed's
owner set themselves (own file, feed dialog, REST/MCP); remote files cannot set them.

Import limits: OPML ≤ 5 MB, ≤ 20 000 outlines, depth ≤ 16, no DTD/entities (XXE /
billion laughs), each selector / XPath / JSON path / header list ≤ 2 000 characters,
filter and condition lists ≤ 10 000 characters — longer values are not imported and
reported (`expression-too-long`).

### Network

- Imported proxies go through the same SSRF checks as feed URLs (at import and at every
  fetch); SOCKS is refused; feed URLs other than http(s) are rejected.
- The fetcher (`headersFromFeed`, all sources: import, feed dialog, REST/MCP) never sends
  `Host`, `Content-Length`, `Transfer-Encoding`, `Connection`, `Keep-Alive`, `Upgrade`,
  `TE`, `Trailer`, `Expect`, `Proxy-Connection` and caps redirects at 20; the importer
  also drops those headers and reports them.
- Import reports carry header **names** only, never values of cookies, headers,
  POST bodies or proxy credentials.

### Export variants

| Variant | Where | Contains |
|---|---|---|
| Default (credential-free) | Manage feeds → Import/Export (default), REST `GET /api/v1/opml`, GReader `subscription/export` | structure, types, XPath/JSON, selectors, filters, ttl, priority, unicity, `CURLOPT_USERAGENT`, `_FOLLOWLOCATION`, `_MAXREDIRS`. **No** cookies, headers, POST fields, proxy, unknown `frss:*`, `user:pass@` in URLs |
| With credentials (opt-in) | Manage feeds → Import/Export, checkbox *Zugangsdaten mitexportieren (FreshRSS-kompatibel)* with a warning; server default `false` (`exportOpml(ids, { includeCredentials: true })`) | additionally `CURLOPT_COOKIE`, `CURLOPT_HTTPHEADER`, `CURLOPT_POST`/`_POSTFIELDS`, `CURLOPT_PROXY`/`_PROXYTYPE`, unknown `frss:*`, URLs as stored — what FreshRSS needs for a full round trip |

Never in any variant: Basic-auth username/password (separate columns), other cURL
options such as `CURLOPT_USERPWD`, connector secrets (RSSHub key, changedetection
token), sealed values that cannot be decrypted. Starter packs have their own generator
without `frss:` attributes. FreshRSS makes the same split (cURL options only in its
private export).

## Known upstream differences

- FreshRSS' importer validates `unicityCriteria` with `^[a-z:_-]{2,64}$`, which
  rejects its own `sha1:*` values (digit). FeedFerret accepts them; importing a
  FeedFerret export into FreshRSS therefore loses `sha1:*` criteria on the FreshRSS side.
- Feeds that already stored a `sha1:*` criterion were keyed by the generic `part:part`
  algorithm in earlier FeedFerret versions (`sha1:title` → the bare title, others → the
  item id). The first sync re-keys such rows in place (id, read/star/labels and
  `updatedAt` kept) and then sets `Feed.dedupeRekeyedFor`, so later syncs skip the legacy
  lookup; changing the criterion re-arms it (`tests/lib/frss-unicity-rekey.sqlite.test.ts`).
- For HTML+XPath feeds without `xPathItemUid`, FreshRSS synthesises the guid
  `urn:sha1:…` from its own processed title/content; FeedFerret has no such guid, which
  only matters in the last-resort fallback (all hashed fields empty).
- Parity gaps of the `sha1:*` GUID (FreshRSS hashes SimplePie's view of an item):
  - content: FreshRSS hashes `get_content()` after SimplePie's sanitising; FeedFerret
    hashes the raw `content:encoded`/`description` as published (before remove-selectors
    and size caps). Differs whenever SimplePie rewrites markup.
  - title: SimplePie decodes entities / strips tags in `get_title()`; FeedFerret hashes
    the title as its parser returns it.
  - guid fallback: FreshRSS runs the item id through `safe_ascii()` and SimplePie's
    HTTPS URL policy; FeedFerret uses the guid as published.
  - link: SimplePie may resolve relative permalinks against `xml:base`; FeedFerret uses
    its own resolved link.
  Consequence: identical keys for ordinary feeds with plain titles/links; a feed moved
  from FreshRSS with content-based criteria can see its current items once more.
