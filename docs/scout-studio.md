# Scout Studio

Scout Studio is FeedFerret's guided extraction workflow for feeds and article pages that need more than a normal RSS/Atom fetch.

## What is implemented now

- Feed Settings → **Full-Text** contains a Scout Studio guide.
- Users can paste an example article URL and run a preview.
- The preview returns cleaned article HTML plus ranked selector candidates.
- Candidate ranking uses text length, paragraph count, and link density.
- Clicking a candidate applies it to the feed's article-body selector.
- Feed Settings → **Scout Studio** contains advanced source controls for HTML, XML, JSON, request options, unicity, and filters.
- OPML import/export uses FeedFerret's `ffx:*` extension prefix while preserving the same stored extraction fields.

## UX goals

- Keep normal users in the guided Full-Text flow.
- Keep raw XPath/JSON/HTTP controls in the advanced Scout Studio tab.
- Never auto-save a selector chosen by the preview; the user applies and then saves.
- Keep previews bounded and sanitized.

## Manual QA checklist

1. Open Feed Management → Feed Settings → Full-Text.
2. Paste an article URL.
3. Click Preview.
4. Verify the cleaned content preview appears.
5. Click a selector candidate.
6. Verify the selector field updates.
7. Save settings and reopen the feed settings.
8. Verify the selector persisted.

## Future extensions

- Visual element picker.
- JSON/XML item selector assistant.
- AI-assisted selector suggestions using the user's configured BYOK provider.
- Rich warnings for weak candidates, duplicate URLs, malformed timestamps, and tiny extraction results.
