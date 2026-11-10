# Moving from FreshRSS

Manage feeds → Import/Export → **Von FreshRSS umziehen / Move from FreshRSS**.
Upload the FreshRSS export ZIP (`freshrss_<user>_<date>_export.zip`), or a single OPML
file, or a single article JSON file (`starred_*.json`, `feed_*.json`). The flow is
always *upload → dry-run preview → confirm → result report*. A dry run writes nothing.

The same pipeline is available over HTTP:

| Endpoint | Auth | Body |
|---|---|---|
| `POST /api/import/freshrss[?dryRun=1]` | session | raw ZIP / OPML / JSON (max 64 MB) |
| `POST /api/v1/import/freshrss[?dryRun=1]` | API token, `write` scope | same |
| `POST /api/v1/opml` `{ "xml", "dryRun" }` | API token, `write` scope | OPML text |
| MCP `feedferret.import_opml` `{ xml, dryRun }` | API token, `write` scope | OPML text |
| Settings UI (OPML upload), remote dynamic-OPML categories | session / background | OPML |

All OPML entry points share `lib/import/opml-import.ts`; the article importer is
`lib/import/freshrss-json.ts`; the ZIP reader `lib/import/zip-reader.ts`; the
orchestration `lib/import/freshrss-migration.ts`.

## Order and idempotency

1. OPML first (so article origins resolve to subscribed feeds), then `starred_*.json`,
   then `feed_*.json`.
2. An article is identified by **origin feed URL + guid** (falling back to link),
   using the exact `dedupeKey` the sync pipeline computes, so a later sync does not
   duplicate imported articles. Re-importing never clears state: read/starred only turn
   on, labels are only added, existing bodies are kept.
3. Articles are written in chunks of 200, each in its own transaction. A failed chunk
   rolls back and is reported with its item range; run the import again to resume.
4. `starred_*.json` also contains label-only articles — they stay unstarred.

## Mapping

| FreshRSS | FeedFerret | Status |
|---|---|---|
| `text`/`title`, `xmlUrl`, `htmlUrl`, `description` | feed name, URL, website, description | supported |
| `type` rss / HTML+XPath / XML+XPath / JSON+DotNotation / JSON+DotPath / JSONFeed / HTML+XPath+JSON+DotNotation | `sourceType` | supported; unknown type → RSS, reported |
| `frss:xPathItem*`, `frss:jsonItem*`, `frss:xPathToJson` | `scraperConfig` | supported (execution fidelity gaps: PHP time formats, JSON concatenation — see research §3) |
| `frss:priority` important/main/category/feed/hidden | `priority` | supported (stored; limited runtime effect) |
| `frss:ttl` (seconds, negative = muted) | `updateFrequency` (5–10080 min), `autoMuted` | supported; clamped values reported |
| `frss:unicityCriteria`, `unicityCriteriaForced` | same | supported (stored; forced flag has no runtime consumer yet) |
| `frss:cssFullContent` | `fullTextSelector` + `fullTextMode=selector` | supported (turned on; never downgrades `auto`/`ai`) |
| `frss:cssContentFilter` | `fullTextRemoveSelectors` | supported |
| `frss:cssFullContentConditions` | `fullTextConditions` | stored, **not evaluated** — reported |
| `frss:filtersActionRead`: plain word / `"phrase"` | literal keyword in `filtersActionRead` | supported (same title+body substring semantics) |
| …: `intitle:` `intext:` `author:` `inurl:`, negated words `-x`/`!x`, `OR` between those terms | feed-scoped auto-read rule (mark read) | supported (exact, never looser) |
| …: regex, `#tag`, parentheses, `date:`/`pubdate:`, `f:` `c:` `e:` `L:` `S:`, multi-word field values, negated phrases, plain words next to other terms (FeedFerret free text also matches author/link/feed name), any value containing `:` `"` `'` outside a single quoted phrase | — | **not imported, reported** (never translated partially or approximately) |
| `frss:CURLOPT_COOKIE/HTTPHEADER/PROXY/POST/POSTFIELDS/USERAGENT/FOLLOWLOCATION/MAXREDIRS` | `httpOptions`, `customUserAgent` | supported for your own file; dropped for remote OPML |
| `frss:CURLOPT_COOKIEFILE` | — | **not imported, reported** (path on the FreshRSS server) |
| `frss:CURLOPT_PROXYTYPE` | `httpOptions` | stored; scheme comes from the proxy URL — reported |
| `frss:opmlUrl` (dynamic category) | `Category.opmlUrl` | supported for your own file; not followed from remote OPML |
| empty categories | categories | supported |
| unknown `frss:*` attributes | `scraperConfig.extensions` | preserved, written back on export, reported |
| article `guid`, link, title, author, body, `published`, `crawlTimeMsec` | `externalId`, link, title, author, sanitized `content`, `publishedAt`, `createdAt` | supported. `createdAt` keeps the FreshRSS crawl time for **read and starred** articles; **unread** articles get the import time instead, so incremental sync clients (Google-Reader/Fever apps) that only ask for recently added items still receive them. Over-long guids (> 2 KB) are stored as a SHA-256 hash, titles are cut at 1 000 characters |
| `…/state/com.google/read`, `…/starred` | `isRead`, `isStarred` | supported |
| `user/-/label/<name>` | labels (created on demand) | supported |
| `enclosure[]` | `enclosures`, media metadata | supported |
| `origin.feedUrl` not subscribed | muted orphan feed (no network fetch) | supported, listed in the report |
| FreshRSS numeric `frss:id` / `tag:google.com,2005:reader/item/<hex>` ids | — | not kept (FeedFerret assigns its own stable numeric ids) |
| user queries, extension config, SQLite backup | — | out of scope (see `.pm/research-freshrss.md` §2) |

Limits of the ordinary FreshRSS UI export still apply: the per-feed files contain only
the most recent 50 entries; for full history use FreshRSS's CLI/DB export.

## Security

- Uploads are read as a bounded stream (64 MB); ZIPs are read in memory only, one entry
  at a time (inflated, imported, released): ≤ 5 000 entries, ≤ 32 MB per entry, ≤ 256 MB
  total (enforced on real inflated output), per-entry and whole-archive ratio cap
  (declared total ÷ upload size ≤ 100), entries must not overlap, CRC checked, no
  encryption/ZIP64, traversal/absolute paths reject the archive. At most 500 000 articles
  per run; a file that would exceed it is reported and skipped.
- Re-importing OPML only overwrites what the outline carries; names, descriptions,
  priority, scraper config and HTTP options set locally are kept, and remote (dynamic
  OPML) syncs never touch HTTP options of existing feeds.
- The session endpoint (`POST /api/import/freshrss`) refuses cross-site requests
  (`Sec-Fetch-Site` / `Origin`).
- OPML: documents with `<!ENTITY>` or an internal DTD subset are rejected (XXE, billion
  laughs); ≤ 20 000 outlines, nesting ≤ 16, text ≤ 5 MB.
- All writes are scoped to the signed-in user; article HTML is sanitized like synced content.
- Rate limits: 6 FreshRSS uploads / 10 min per user, 10 OPML imports / min per user;
  one import at a time per user.
