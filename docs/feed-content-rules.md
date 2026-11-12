# Per-feed content rules

Feed settings → Scout Studio → Clean content accepts a JSON object. Rules run in array order after the existing CSS removal filter, before sanitization and article metadata. These rules also clean automatic and manual full text before the final quality and duplicate checks. Cross-feed story clustering and existing keyword/AI auto-read rules remain unchanged.

```json
{
  "transforms": [
    {"type": "strip_selector", "css": ".sponsor, footer"},
    {"type": "replace_regex", "pattern": "Advertisement", "replacement": "", "flags": "gi"},
    {"type": "strip_text_before", "marker": "<!-- article starts -->"},
    {"type": "strip_text_after", "marker": "<!-- article ends -->"}
  ],
  "gates": [
    {"type": "title_include", "pattern": "release", "flags": "i"},
    {"type": "title_exclude", "pattern": "sponsored", "flags": "i"},
    {"type": "numeric_min", "pattern": "(\\d+) points", "minimum": 100}
  ]
}
```

Markers are literal HTML substrings, removed along with the prefix/suffix; absent markers leave content intact. Regex replacement uses JavaScript replacement semantics (`$1`, `$$`, etc.), flags default to empty. All gates must pass. They examine the original title and visible feed body before transformations; numeric gates use capture group 1, and missing/non-numeric values fail. Failed items are not stored and can qualify on a later fetch. Existing stored items are never deleted by gates. Keyword muting (`filtersActionRead`) continues marking new matches read and excluding them from notifications.

Regex syntax, configuration sizes and `safe-regex` checks are enforced on save, REST writes and OPML imports. The heuristic can reject safe expressions and miss ambiguous alternation; every item additionally runs inside a terminable HTML worker with a two-second wall-clock budget. A timeout fails ingestion closed so it retries later. Input is bounded by the existing HTML guard. Up to 20 transforms and 10 gates are allowed, configuration is limited to 32 KB. Replacement output is sanitized again.

An additive upstream SHA-256 records the original publisher body before transforms. Rule-only changes do not rewrite stored articles or advance `Article.updatedAt`; legacy rows conservatively adopt their first hash without rerendering. Changes apply on subsequent publisher body changes or to new items. No apply-to-existing action is provided. Identity hashes continue using the original feed fields, so changing a cleaning rule cannot create duplicate items. The live preview uses the latest **stored** body, which may already be cleaned; it never writes articles or fetches a publisher page.

REST v1 feed GET/PATCH exposes the nullable JSON string `contentRules`. Clearing it with null disables the new rules. MCP feed update accepts the same field; OPML import/export also carries the configuration.

OPML keeps the existing FreshRSS `cssContentFilter`, `cssFullContent`, `filtersActionRead` and XPath/pathEntries mappings. FreshRSS-compatible CSS cleanup and keyword filters should use those existing controls. Arbitrary ordered replacements and numeric gates have no direct FreshRSS OPML equivalent: `frss:contentRules` is a FeedFerret extension for lossless FeedFerret round trips, and FreshRSS may ignore it. Remote/dynamic OPML cannot install executable content rules; unsafe local imports are reported and ignored.

Rollback: clear contentRules (and any CSS filters) per feed. Existing article content is deliberately preserved. The nullable schema additions can remain in place.
