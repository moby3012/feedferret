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

Markers are literal HTML substrings, removed along with the prefix/suffix; absent markers leave content intact. Regex replacement uses JavaScript replacement semantics (`$1`, `$$`, etc.), flags default to empty. All gates must pass. They examine the original title and visible feed body before transformations; numeric gates use capture group 1, and missing/non-numeric values fail. Failed items are not stored and can qualify on a later fetch. Adding or tightening a gate does not delete or mark read existing articles; it prevents further ingestion/updates for non-matches. Relaxing or removing gates admits previously held entries on the next changed feed response (a cached 304 is not reprocessed). Legacy identity rekeying still runs for held entries before advancing the feed migration marker, preserving IDs, read/star state and timestamps when gates are later relaxed. Keyword muting (`filtersActionRead`) continues marking new matches read and excluding them from notifications.

Regex syntax, configuration sizes and `safe-regex` checks are enforced on save, REST writes and OPML imports. A conservative regex AST policy additionally rejects backreferences, quantified alternations, nested quantifiers, quantifiers inside lookbehind, and more than two unbounded quantifiers. This may reject safe expressions. Rule batches (up to 50 items / 512 KiB) run in terminable HTML workers with a two-second execution limit and an eight-second per-feed rules budget. A timed-out batch is retried item by item within that budget. Too-complex items and items beyond the budget fall back to default-sanitized bodies, skipping both transforms and gates; a warning records the fallback. The feed still succeeds and does not auto-mute because of a rule timeout. Missing/busy workers retain the normal retry behavior. Input is bounded by the existing HTML guard. Up to 20 transforms and 10 gates are allowed, configuration is limited to 32 KB. Replacement output is sanitized again.

Only feeds with content rules compute an upstream SHA-256, using the default-sanitized body (existing removeSelectors plus DOMPurify, without the new transforms). Raw script/nonces and removed advertising blocks therefore cannot churn this hash. Feeds without rules keep the main sync path: no hash computation, no rule-derived keepStored and no extra writes. Matching hashes freeze only the body/excerpt; images, enclosures and media metadata still update. Rule-only changes do not rewrite stored articles or advance `Article.updatedAt`; legacy rows conservatively adopt their first hash without rerendering. Changes apply on subsequent publisher body changes or to new items. No apply-to-existing action is provided. Identity hashes continue using the original feed fields, so changing a cleaning rule cannot create duplicate items. The live preview uses the latest **stored** body, which may already be cleaned; it never writes articles or fetches a publisher page. Preview rejects remove-selector strings longer than 1000 characters, uses background worker priority, and is limited to 30 requests per user per minute.

REST v1 feed GET/PATCH exposes the nullable JSON string `contentRules`. Clearing it with null disables the new rules. MCP feed update accepts the same field; OPML import/export also carries the configuration.

OPML keeps the existing FreshRSS `cssContentFilter`, `cssFullContent`, `filtersActionRead` and XPath/pathEntries mappings. FreshRSS-compatible CSS cleanup and keyword filters should use those existing controls. Arbitrary ordered replacements and numeric gates have no direct FreshRSS OPML equivalent: `frss:contentRules` is a FeedFerret extension for lossless FeedFerret round trips, and FreshRSS may ignore it. Remote/dynamic OPML cannot install executable content rules; unsafe local imports are reported and ignored.

Rollback: clear contentRules (and any CSS filters) per feed. Existing article content is deliberately preserved. The nullable schema additions can remain in place.
