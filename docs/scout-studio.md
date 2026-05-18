# Scout Studio

Scout Studio is FeedFerret's guided full-text extraction workflow for feeds and article pages that need more than a standard RSS/Atom fetch.

---

## What is Implemented (v1.0.0)

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
| AI-assisted selector suggestions | Use the user's BYOK AI provider to suggest CSS selectors | M |
| Rich candidate warnings | Warnings for weak candidates, duplicate URLs, malformed timestamps, tiny extraction results | S |
