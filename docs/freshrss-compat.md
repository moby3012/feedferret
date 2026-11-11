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

Legend — **Import**: what FeedFerret does with it. **Export**: written back.
**Round trip**: FreshRSS → FeedFerret → FreshRSS gives the same value
(booleans compared as FreshRSS reads them, line lists as sets).

| Attribute | FeedFerret mapping | Import | Export | Round trip |
|---|---|---|---|---|
| `type` rss / HTML+XPath / XML+XPath / JSON+DotNotation / JSONFeed / HTML+XPath+JSON+DotNotation | `sourceType` | ✅ (`JSON+DotPath` → JSON+DotNotation, unknown → RSS, reported) | ✅ | ✅ |
| `frss:xPathItem` … `frss:xPathItemUid` (10) | `scraperConfig.xpath` | ✅ | ✅ | ✅ |
| `frss:jsonItem` … `frss:jsonItemUid` (10), `frss:xPathToJson` | `scraperConfig.json`, `.xPathToJson` | ✅ | ✅ | ✅ |
| `frss:priority` important / main / category | `priority`; category → `hideFromAllFeeds` | ✅ | ✅ (also: hidden-from-All-feeds → `category`) | ✅ |
| `frss:priority` feed / hidden | `priority` + `hideFromAllFeeds` | ⚠️ approximated (still listed in its category), reported | ✅ | ✅ |
| `frss:ttl` (s, negative = muted) | `updateFrequency` (5–10080 min), `autoMuted` | ✅; rounded/clamped values reported | ✅ signed; muted feeds without own interval use the account default | ✅ (original kept in `scraperConfig.preserved.ttl` while the interval is unchanged) |
| `frss:unicityCriteria` id / link / `sha1:*` (all 9) | `unicityCriteria` → article identity | ✅ — `sha1:*` hashed exactly like FreshRSS | ✅ | ✅ |
| `frss:unicityCriteriaForced` | `unicityCriteriaForced` | ✅ (FeedFerret never degrades criteria, i.e. always behaves as forced) | ✅ | ✅ |
| `frss:cssFullContent` | `fullTextSelector`, `fullTextMode=selector` (never downgrades auto/ai) | ✅ | ✅ while full text is on (in FreshRSS the selector *is* the switch) | ✅ |
| `frss:cssContentFilter` (+ legacy `frss:cssFullContentFilter`) | `fullTextRemoveSelectors` — removed from feed content **and** full text | ✅ | ✅ | ✅ |
| `frss:cssFullContentConditions` | `fullTextConditions` — full text only for matching articles | ✅; if a line is not translatable, full text for all articles, reported | ✅ | ✅ |
| `frss:filtersActionRead` plain word / `"phrase"` | keyword in `filtersActionRead` | ✅ | ✅ (quoted when FreshRSS would read it as syntax) | ✅ |
| `frss:filtersActionRead` `intitle:` `intext:` `author:` `inurl:`, `-x`, `OR` | feed-scoped auto-read rule | ✅ exact | ✅ original line | ✅ |
| `frss:filtersActionRead` other syntax (regex, `#tag`, `date:`, parentheses …) | — (inactive) | ❌ reported | ✅ original line | ✅ (kept in `scraperConfig.preserved`) |
| `frss:CURLOPT_USERAGENT` | `httpOptions` / `customUserAgent` | ✅ | ✅ private export only | ✅ |
| `frss:CURLOPT_COOKIE`, `_POST`, `_POSTFIELDS`, `_FOLLOWLOCATION` | `httpOptions` | ✅ own file; ❌ remote OPML | ✅ private export only | ✅ |
| `frss:CURLOPT_HTTPHEADER` | `httpOptions` | ✅ own file; `Host`, framing/hop-by-hop headers dropped + reported (names only); ❌ remote | ✅ private export only | ✅ (minus dropped headers) |
| `frss:CURLOPT_MAXREDIRS` | `httpOptions` (0–20) | ✅; clamped values reported | ✅ | ✅ within range |
| `frss:CURLOPT_PROXY` / `_PROXYTYPE` | `httpOptions` (HTTP/HTTPS proxy, scheme added) | ✅ own file, same SSRF rules as feed URLs; SOCKS or internal → dropped, reported; ❌ remote | ✅ private export only | ✅ (proxy gains an explicit `http://`) |
| `frss:CURLOPT_COOKIEFILE` | — | ❌ reported (path on the FreshRSS server; FreshRSS itself only keeps `""`) | — | — |
| `frss:opmlUrl` (category) | `Category.opmlUrl` (dynamic OPML) | ✅ own file; ❌ nested in remote OPML | ✅ | ✅ |
| `category` attribute on a root feed | category by name | ✅ | — (feeds are nested instead) | ✅ structurally |
| empty categories | categories | ✅ | ✅ | ✅ |
| unknown `frss:*` | `scraperConfig.extensions` | stored, reported | ✅ private export only | ✅ |

Not part of the FreshRSS OPML format (so not exchanged): keep-history / max-items,
per-category refresh interval, FeedFerret-only reader settings. HTTP Basic auth lives
in the feed URL in FreshRSS; FeedFerret stores it separately and API exports strip it.

## Security

- Remote (dynamic) OPML never sets cookies, headers, proxy or POST options, never
  creates auto-read rules and never follows nested dynamic categories.
- Imported proxies go through the same SSRF checks as feed URLs; feed URLs other than
  http(s) are rejected.
- Import reports carry header **names** only, never values of cookies, headers,
  POST bodies or proxy credentials.
- API/GReader exports (`generateApiOpml`) omit all cURL options, the user agent,
  unknown extensions and URL credentials, like FreshRSS' public share export.

## Known upstream differences

- FreshRSS' importer validates `unicityCriteria` with `^[a-z:_-]{2,64}$`, which
  rejects its own `sha1:*` values (digit). FeedFerret accepts them; importing a
  FeedFerret export into FreshRSS therefore loses `sha1:*` criteria on the FreshRSS side.
- Changing an existing feed to a `sha1:*` criterion re-keys its future articles
  once (same as FreshRSS).
