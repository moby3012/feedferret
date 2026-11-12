# Reader media and alternative frontends

The app presentation boundary reuses the signed-image proxy's bounded HTML worker.
It recognizes YouTube watch/shorts/live/youtu.be, Vimeo, Dailymotion, Twitch
VODs/clips, PeerTube /videos/watch/ links, and v.redd.it. No oEmbed API,
publisher page, Reddit JSON, or third-party script is fetched to discover media.
Stored article content and Article.updatedAt are untouched. GReader, Fever and
REST API responses retain original content and links.

YouTube, Vimeo, Dailymotion and Twitch show a keyboard-accessible load button.
There is no iframe src until the button is clicked. YouTube thumbnails appear
only as signed same-origin image-proxy URLs when that proxy is enabled; this
does fetch the thumbnail server-side before the click. Without the proxy,
placeholders contain text only. Clicking creates a sandboxed, lazy iframe with
no-referrer and only fullscreen permission. Twitch receives the reader's hostname
as its required parent parameter and has autoplay disabled.
YouTube uses [privacy-enhanced embeds](https://support.google.com/youtube/answer/171780);
Twitch follows its [video/clip embed parameters](https://dev.twitch.tv/docs/embed/video-and-clips).
Playback can still depend on provider policy, geographic restrictions and
referrer requirements. The no-referrer choice is intentional.

Reading settings accept an HTTPS instance **origin** for Invidious/Piped,
Redlib, or Nitter-compatible services. Empty disables rewriting; Reddit also
accepts 'old' for old.reddit.com. Credentials, paths, query strings, fragments,
literal IPs and localhost are rejected. No public alternative instance is
selected automatically. Instances are navigation destinations only, never
server-side fetch targets. Both YouTube frontends use /watch?v=.
Preference changes invalidate the existing 30-second process-local settings
cache and app article/list queries. Other replicas expire their cache within 30s.

Custom frontend destinations and arbitrary PeerTube instances open in a new
tab with noopener/noreferrer. They deliberately do not use iframes: neither the
static enforced legacy CSP nor a future enforced nonce CSP can enumerate
per-user or per-article origins safely. Both policies have the same explicit
frame-src list for fixed providers and media-src allowing self, https and v.redd.it. The nonce policy remains report-only.
Adding arbitrary https: to frame-src would weaken that restriction.

Reddit RSS gallery/preview links to preview.redd.it and i.redd.it become inline
images only when the proxy is enabled. Otherwise they remain links. Only images actually exposed in RSS
are available; a gallery page URL alone cannot reveal missing images without
an extra discovery request. v.redd.it is click-to-load native video: explicit
media paths are preserved, and bare video IDs use DASH_720.mp4 (which can be
unavailable or silent on some posts). No stored-content normalization occurs.

The app keeps the canonical article link for Copy link, Share and favicon lookup.
A separate app-only openLink is used solely by open-original actions.

## Embeds at ingest

Feed-item sanitizing (`lib/feed-item-sanitize.ts`, plain feed-sync path) turns an
`<iframe src>` of a provider in the table above that has a canonical watch page
(YouTube, Vimeo, Dailymotion, Twitch, v.redd.it) into a plain
`<a href="canonical watch URL">`; the URL is built from the matched id by
`watchUrlForEmbed` (same matcher as `videoFor`), never copied from the source.
No iframe is ever stored; every other iframe is stripped as before. At render
time the link becomes a click-to-load placeholder like any other video link.
Feeds with content rules and the FreshRSS import keep the default profile.

Existing articles are not touched: the change check of sync compares the stored
body with the freshly sanitized one, so an item that merely sanitizes
differently after the deploy would look edited (updatedAt bump, full-text reset).
The sanitizer therefore also returns the pre-feature form (`legacyHtml`, only
for items where a link was added) and sync keeps the stored body when it equals
that form. Only new rows and rows whose upstream content really changed get the
link; a row that has it is compared against the new form as usual.

The worker is skipped for ordinary articles unless the proxy is enabled, a
frontend is configured, or a cheap string check finds a supported media candidate.
Markdown output carries its renderer provenance so both sanitization passes
preserve KaTeX metrics without trusting publisher-supplied KaTeX classes.

Ingest sanitization currently strips iframe-only embeds. The presentation worker
can transform iframes in legacy/render-time inputs, but cannot reconstruct an
iframe already removed at ingest. Converting those to links at ingest is deferred
to avoid changing stored-content behavior in this render-only work package.

The player sandbox intentionally omits allow-popups. Provider controls that open
new windows may not function; users can use the reader's open-original action.

The worker sanitizes before and after rewriting, strips publisher-supplied
control markers and never preserves active iframes. The click handler rechecks
provider URLs before creating a player. Worker failure falls back to escaped
plain text, never restores embeds.

Rollback: revert the presentation/UI changes or clear custom frontend
preferences. The additive user columns can remain in place. No content backfill
or reverse Article update is needed.
