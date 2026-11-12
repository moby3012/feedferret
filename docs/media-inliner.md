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
frame-src list for fixed providers. The nonce policy remains report-only.
Adding arbitrary https: to frame-src would weaken that restriction.

Reddit RSS gallery/preview links to preview.redd.it and i.redd.it become inline
images (signed when the proxy is enabled). Only images actually exposed in RSS
are available; a gallery page URL alone cannot reveal missing images without
an extra discovery request. v.redd.it is click-to-load native video: explicit
media paths are preserved, and bare video IDs use DASH_720.mp4 (which can be
unavailable or silent on some posts). No stored-content normalization occurs.

The worker sanitizes before and after rewriting, strips publisher-supplied
control markers and never preserves active iframes. The click handler rechecks
provider URLs before creating a player. Worker failure falls back to escaped
plain text, never restores embeds.

Rollback: revert the presentation/UI changes or clear custom frontend
preferences. The additive user columns can remain in place. No content backfill
or reverse Article update is needed.
