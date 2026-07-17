# Scout Studio

Scout Studio is FeedFerret's guided full-text extraction workflow for feeds and article pages that need more than a standard RSS/Atom fetch — including turning a plain listing page (a blog index, forum, or search-results page) that has **no** RSS/Atom feed into one.

---

## What is Implemented

### Create Feed from a Web Page (Add feed → "From web page")

A guided, zero-XPath way to build a feed from any listing page (Feed Intelligence **M3**):

- Paste a listing-page URL and click **Find items**. FeedFerret fetches it (SSRF-safe) and analyses the DOM for the repeating item block.
- It proposes one or more **ranked candidates**, each validated by running its selectors through the real scraping engine — a candidate only appears if it parses into real, linked items. Ranking uses repetition count, link density, title quality, and field richness, penalising nav/header/footer.
- Each candidate shows its item count, sample titles, and a live preview of the first parsed items; the strongest is pre-selected.
- Pick one, give the feed a name, and save. The feed is stored as a normal `HTML+XPath` source (the proposed selectors become its `scraperConfig`), so it re-scrapes on the sync schedule, dedups via the usual unicity keys, and exports/imports through the `ffx:*` OPML extension like any other scraped feed.
- Nothing is saved until you confirm. If no candidate is found, the panel points to the manual Scout Studio and direct-URL routes.

Under the hood the suggestion engine (`lib/page-feed-suggest.ts`) proposes the config; the existing `buildXPathArticles` engine both validates it and later scrapes it. This is the foundation the AI config proposal (M4) builds on — same config shape, same validation, with the selectors proposed by an LLM instead of heuristics.

### Guided Full-Text Flow (Feed Settings → Full-Text)

- Paste an example article URL and run a live preview.
- Preview returns cleaned article HTML plus ranked selector candidates.
- Candidate ranking uses text length, paragraph count, and link density.
- Clicking a candidate applies it to the feed's article-body selector field.
- Selector is never auto-saved — the user applies and then explicitly saves.

### Advanced Scout Studio (Feed Settings → Scout Studio)

Advanced source controls for power users:

- **HTML** — custom CSS selector for article body extraction
- **XML** — XPath expression for custom XML feeds
- **JSON** — JSONPath expression for JSON feeds
- **Request options** — custom headers, user-agent, HTTP auth
- **Unicity** — deduplication key field configuration
- **Filters** — include/exclude rules for item filtering

### OPML Integration

OPML import/export uses FeedFerret's `ffx:*` extension prefix to preserve Scout Studio extraction settings across instances. Standard OPML compatibility is maintained — other readers ignore `ffx:*` attributes.

---

## UX Principles

- Keep normal users in the guided Full-Text flow.
- Keep raw XPath/JSON/HTTP controls in the advanced Scout Studio tab.
- Never auto-save a selector chosen by the preview; the user applies then saves.
- Keep previews bounded and sanitized (DOMPurify).

---

## Manual QA Checklist

1. Open Feed Management → Feed Settings → Full-Text.
2. Paste an article URL from the feed.
3. Click Preview.
4. Verify cleaned content appears and selector candidates are ranked.
5. Click a selector candidate.
6. Verify the selector field updates.
7. Save and reopen feed settings.
8. Verify the selector persisted.
9. Trigger a feed sync and verify articles use the custom selector.

---

## Planned Extensions (Post-v1.0)

These are not yet scheduled to a specific release. See [`docs/releases/backlog.md`](releases/backlog.md).

| Extension | Description | Effort |
|---|---|---|
| Visual element picker | Click-to-select UI overlaid on a live article preview | L |
| JSON/XML item selector assistant | Guided wizard for non-HTML feeds | M |
| AI-assisted selector suggestions | 🔄 Engine shipped as M4 slice 1 (`lib/ai-feed-config.ts`, PR #149) — UI pending. See [`docs/feed-intelligence-roadmap.md`](feed-intelligence-roadmap.md). | M |
| Rich candidate warnings | Warnings for weak candidates, duplicate URLs, malformed timestamps, tiny extraction results | S |
