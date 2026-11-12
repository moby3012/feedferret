# Image privacy proxy

Existing and new installations default to **Off**. An administrator chooses
**Off**, **Opt-in**, or **Always on** under Server settings → Sync. Opt-in honors
“Load images through FeedFerret (privacy)” in Settings → Reading; Always on
overrides personal preferences. Reload open clients after changing the global
mode. Older offline article snapshots retain their original URLs; refresh
articles online to replace them.

Only app presentation responses are rewritten: article bodies, responsive
img/picture candidates, video posters, reader covers and list/cluster thumbnails.
Relative URLs resolve against the article link. Data images remain inline.
Audio/video streams and iframes are outside this image-only feature.
Nothing is written back to articles; updatedAt, GReader/Fever and REST API output
remain unchanged.

URLs use `/api/media?u=<canonical-http-url>&s=<hmac-sha256>`. Keys use the shared
secret-box HKDF helper and purpose `media-proxy.url.v1`, never raw AUTH_SECRET.
Current and configured old encryption masters verify signatures. Canonicalization
removes fragments, normalizes host/default ports and refuses embedded credentials.

Signatures are per instance, without user identifiers or expiry, for stable
cacheable URLs. Network requests additionally require an active session cookie
and enabled proxy setting. Successful responses intentionally use public,
immutable seven-day HTTP caching: shared caches may serve cached bytes without
contacting the session gate. Avoid a shared CDN cache if this is undesirable;
a signature is a capability for cached image bytes, not a confidentiality boundary.
No cookies, Authorization or Referer are forwarded upstream; only a generic
User-Agent and image Accept header are sent.

safeFetch pins DNS/socket resolution and checks every redirect (at most five),
refusing private/loopback addresses regardless of internal-feed settings.
The full transfer has a 20-second deadline. Only image/* excluding SVG is accepted,
with a 15 MiB cap checked against declared length and while streaming. Oversized
chunked responses terminate the stream (status may already be 200). Upstream
cookies and arbitrary headers are discarded; ETag and Last-Modified pass through.
Range is unsupported. Per-process limits: 300 requests/user/minute and 600/IP/minute;
multi-replica installations should also rate limit at their reverse proxy.

The service worker caches proxied images in its existing bounded runtime cache,
cleared on logout. The offline reader embeds cached proxy bytes as data URLs inside its opaque-origin sandbox. There is no disk
cache or new container. CSP report-only rollout and the app's legacy policy are
unchanged; media responses set default-src 'none', nosniff and same-origin CORP.

Rollback: select Off, reload clients and clear offline/runtime caches if needed.
Keep the two additive database columns when rolling back the application.

Validation covers signatures, settings modes, worker rewriting, anonymous headers,
MIME/streaming limits, private-address redirects and reader E2E against the local
fixture image server. E2E preloads an exact synthetic-host transport mapping into
the test server process; production SSRF policy has no test bypass.
