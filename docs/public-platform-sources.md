# Public Telegram, Bluesky and Mastodon sources

## Telegram public channels

Paste `https://t.me/example_channel`, `https://t.me/s/example_channel`, or
`https://telegram.me/example_channel` into **Add Feed → By URL**. FeedFerret
verifies the public web preview and stores the canonical
`https://t.me/s/example_channel` source. No account, credentials or RSSHub
container is required. Existing RSSHub radar rules remain available as a
fallback when the preview cannot be fetched and RSSHub is configured.

Sync reads only the latest preview page, without traversing older pages.
Message IDs (`channel/message-number`) remain stable between syncs. Text is
sanitized in the isolated HTML worker. Photo galleries, publication dates,
message links and forwarding notes (`↪ origin`) are retained. Telegram serves
video files from rotating signed URLs, so videos are stored as their poster
image linking to the post, never as a media source. Any media URL carrying
volatile query parameters (`token`, `expires`, `sig`, …) is dropped rather than
stored, since such URLs change every sync and soon answer 403. A feed already
configured with an HTML/XPath/JSON source type on a `t.me` page keeps that
parser. HTTP 429/5xx from Telegram is a temporary error (rate-limited hint,
host backoff), not "channel does not exist". Private channels,
invite links and channels without a public web preview cannot be ingested;
discovery reports an unavailable public preview. Empty public histories are
valid and will populate when messages appear. Telegram can change the preview
markup; this adapter depends on the public timeline structure.

## Bluesky

Profile URLs resolve to Bluesky's native
`https://bsky.app/profile/<handle-or-did>/rss` feed, including custom-domain
handles. By default, sync makes one additional credential-free request to the
[public AppView author-feed API](https://docs.bsky.app/docs/api/app-bsky-feed-get-author-feed)
for up to 100 recent entries. Matching RSS entries gain full-size image
galleries, video playlists/posters, and quoted text when the quote is public.
RSS identities and publication dates remain authoritative. Enrichment is
monotonic: when the API call fails, is rate limited, or does not cover an item
(older than the 100-entry window), the stored row is left untouched instead of
being rewritten with the plainer RSS text. Only the content-derived fields
(text, excerpt, images, enclosures, media metadata) are frozen; title, link and
full-text retries behave normally. Consequence ("freeze" cases): with a
persistent AppView failure, or for a post older than the 100-entry window, the
stored content stays as it was first stored (plain RSS text if the post was
never enriched) until enrichment covers the item again. Reposts and entries
outside that latest API page are enriched only when their author and post key
match an RSS item. Deleted or unavailable quotes remain absent. Playlist
playback depends on browser support for HLS.

Set `FEEDFERRET_BLUESKY_ENRICHMENT=false` to disable enrichment globally. For
one feed, set `"blueskyEnrichment": false` in its advanced `scraperConfig`
JSON (preserving any other settings). Both switches disable the additional
network request. RSS sync continues normally if AppView is unavailable, times
out, rate limits the request, or returns malformed data. Conditional RSS 304
responses skip enrichment until the feed changes again.

## Mastodon

Public profile URLs (`https://social.example/@demo`) continue resolving to
the instance's native `@demo.rss` feed. For Fediverse profile feeds (URL path
`/@name.rss` or `/users/name.rss`) image `media:content` attachments are kept
as enclosures and shown inline when the post text has no inline image;
duplicate URLs and size variants of one image collapse. Audio/video stay
available to the existing player via the item's media. Every other feed
(news, podcasts, forums, video) is processed exactly as before, so existing
stored articles are not rewritten. Native RSS text, including quote text
supplied by the instance, is retained. No API requests or credentials are
needed. Instances that disable public RSS cannot be ingested through this path.

All outbound requests use the SSRF-protected transport. Preview parsing runs
only in the HTML worker; these sources do not execute upstream scripts.
