# Image privacy proxy

Existing and new installations default to **Off**. An administrator chooses
**Off**, **Opt-in**, or **Always on** under Server settings → Sync. Opt-in honors
“Load images through FeedFerret (privacy)” in Settings → Reading; Always on
overrides personal preferences. Reload open clients after changing the global
mode. Older offline article snapshots retain their original URLs; refresh
articles online to replace them.

Only app presentation responses are rewritten: article bodies, responsive
img/picture candidates, image inputs, video posters, reader covers and list/cluster thumbnails.
Relative URLs resolve against the article link. Data images remain inline.
Audio/video streams and iframes are outside this image-only feature. When enabled,
audio/video elements and their source elements have autoplay removed and preload
set to none. Playing media explicitly can still contact the publisher.
Nothing is written back to articles; updatedAt, GReader/Fever and REST API output
remain unchanged.

URLs use `/api/media?u=<canonical-http-url>&s=<hmac-sha256>`. Keys use the shared
secret-box HKDF helper and purpose `media-proxy.url.v1`, never raw AUTH_SECRET.
Current and configured old encryption masters verify signatures. Canonicalization
removes fragments, normalizes host/default ports and refuses embedded credentials.

Signatures are per instance, without user identifiers or expiry, for stable
cacheable URLs. Network requests additionally require an active session cookie
and enabled proxy setting. Successful responses use private, immutable seven-day
HTTP caching: browsers can reuse images, but shared caches must not store them.
The explicit PWA runtime cache is local to the browser and cleared on logout.
No cookies, Authorization or Referer are forwarded upstream; only a generic
User-Agent and image Accept header are sent.

safeFetch pins DNS/socket resolution and checks every redirect (at most five),
refusing private/loopback addresses regardless of internal-feed settings.
The full transfer has a 20-second deadline and must receive its first body byte
within five seconds (including DNS, headers and redirects). Aborting a partial
transfer errors the response body so neither HTTP nor service-worker caching
can commit a clean, truncated success. Only PNG, JPEG, GIF, WEBP, AVIF, BMP
and ICO MIME types are accepted. Ambiguous or duplicate MIME values and unknown
parameters are refused (one charset parameter is allowed and discarded). A bounded
32-byte prefix is checked against the declared format before returning success;
this checks file signatures, not complete image validity. Content-Type is always
our normalized allow-listed value. SVG is refused,
with a 15 MiB cap checked against declared length and while streaming. Oversized
chunked responses terminate the stream (status may already be 200). Upstream
cookies and arbitrary headers are discarded; ETag and Last-Modified pass through.
Range is unsupported. Per-process limits: 300 requests/user/minute and 600/IP/minute;
a further 500 MiB/user/hour byte budget includes prefix reads and rejected chunks.
Set FEEDFERRET_MEDIA_USER_BYTES_PER_HOUR to a positive integer to change the budget.
At most 32 transfers per process, six per user and four per upstream hostname
run concurrently. Host limits also apply after redirects (503 for global/host
saturation, 429 for a user limit). Slots are released on completion, cancellation,
error or deadline, including unconsumed responses. Budget exhaustion while
streaming terminates the response; before headers it returns 429. Accounting is
bounded and local to the process; multi-replica installations should also limit at
their reverse proxy.

Global mode and opt-in user flags are cached in memory for 30 seconds with
coalesced concurrent reads. Same-process settings writes invalidate immediately;
other replicas expire within 30 seconds. If the HTML worker fails, the reader
returns escaped plain text with fetching elements removed, plus a signed cover,
instead of returning an error or restoring direct publisher URLs.

The service worker caches proxied images in its existing bounded runtime cache,
cleared on logout. The offline reader embeds cached proxy bytes as data URLs inside its opaque-origin sandbox. There is no disk
cache or new container. CSP report-only rollout and the app's legacy policy are
unchanged; media responses set default-src 'none'; sandbox, nosniff and same-origin CORP.

Rollback: select Off, reload clients and clear offline/runtime caches if needed.
Keep the two additive database columns when rolling back the application.

Validation covers signatures, settings modes, worker rewriting, anonymous headers,
MIME/streaming limits, private-address redirects and reader E2E against the local
fixture image server. E2E preloads an exact synthetic-host transport mapping into
the test server process; production SSRF policy has no test bypass.
