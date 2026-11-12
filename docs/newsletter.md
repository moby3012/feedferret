# Newsletter inbox (email → feed)

FeedFerret turns newsletters into feeds. An admin sets up **one inbox** for the instance
(Admin → Server settings → Newsletter); afterwards every user copies their own address from
Settings → Newsletter and subscribes with it. New senders appear automatically as feeds in
the "Newsletter" folder, with the same reader, rules, search and GReader / Fever / FreshRSS
sync as any other feed.

There are three ways to get mail in. They all end in the same ingest (recipient token →
user, tracking-pixel and HTML sanitizing, de-duplication by Message-ID, daily limit of 100
mails per user, double-opt-in banner, one-click unsubscribe), so features behave the same
whichever you choose. One way is active per instance; switching asks for confirmation
because every user address changes.

| Way | Needs | Addresses | Direction |
|---|---|---|---|
| **Connect an existing mailbox (IMAP)** — recommended | an e-mail address + app password, no domain | `box+ff-<token>@provider` | FeedFerret polls |
| **Your own domain via Cloudflare (free)** | a domain on Cloudflare, public `https://` FeedFerret | `<token>@your-domain` | Cloudflare Worker pushes |
| **Mail service with webhook** (Postmark, Mailgun, …) | an account there + public `https://` FeedFerret | `<token>@your-domain` | the service pushes |

The push ways need FeedFerret to be reachable from the internet over HTTPS (see
[reverse-proxy.md](./reverse-proxy.md)). Behind NAT without a public address use IMAP.

## Cloudflare (own domain, free)

In the wizard choose **Eigene Domain über Cloudflare (kostenlos)**, enter the domain (or
subdomain) the addresses should live on and press *Generate secret*. The wizard then shows
a ready-to-paste **Worker script** with your FeedFerret URL and the new secret already filled in.
The secret is shown **only once**; if you lose it, set the way up again from the status card
("Change setup / new secret") — the old secret stops working immediately.

1. Cloudflare dashboard → your domain → **Email → Email Routing** → enable. Cloudflare creates
   the MX/TXT records itself.
2. **Workers & Pages → Create → Worker**, name it e.g. `feedferret-inbox`, open *Edit code*,
   replace everything with the script from the wizard, **Deploy**.
3. **Email Routing → Routing rules → Catch-all address** → action *Send to a Worker* →
   `feedferret-inbox` → save and activate.
4. Back in the wizard press **Continue to test** and **Send test mail** (or mail the shown
   address yourself with the shown subject). The page waits live and shows
   "arrived in N s".

The worker rejects mail over 10 MB and bounces permanently when FeedFerret answers 401, 403,
404, 410 or 413 (wrong secret, source paused or removed); it fails temporarily (Cloudflare retries /
reports) on anything else, e.g. 429 or 5xx. Look into *Workers → Logs* if nothing arrives.

## Mail service with webhook (Postmark, Mailgun)

Choose **Mail-Dienst mit Webhook**, enter the domain whose MX record points to the service and
generate the secret. The wizard shows the endpoint
`https://<your-instance>/api/webhooks/inbound-email/<source id>` twice: with credentials and
plain.

Postmark and Mailgun cannot add custom signature headers, so they authenticate with **HTTP
Basic auth embedded in the URL**: user name `feedferret` (any), password = the secret. This
is only safe over HTTPS.

- **Postmark:** in the server's *inbound stream* enter the URL with credentials as webhook,
  and point an MX record of your domain to `inbound.postmarkapp.com` (priority 10).
  "Include raw email content in JSON payload" is optional; without it FeedFerret rebuilds the
  message from Postmark's parsed fields (headers, text, html, inline images).
- **Mailgun:** *Receiving → Routes*, a route matching the recipients on your domain, action
  *Forward* to the URL with credentials, and Mailgun's MX records on the domain. FeedFerret
  accepts the form-encoded / multipart "parsed" format and `body-mime`.

## Own relays (HMAC signature)

Anything that can compute an HMAC can post to the same endpoint — this is exactly what the
Cloudflare script does.

```
POST /api/webhooks/inbound-email/<source id>
Content-Type: message/rfc822
X-FeedFerret-Timestamp: <unix seconds>
X-FeedFerret-Recipient: <envelope recipient, e.g. token@your-domain>
X-FeedFerret-Signature: sha256=<hex HMAC-SHA256(secret, timestamp + "\n" + recipient + "\n" + body)>

<raw RFC 822 message>
```

Accepted bodies (by `Content-Type`):

| Content-Type | Body |
|---|---|
| `message/rfc822`, `text/plain`, `application/octet-stream` | the raw message |
| `application/json` | Postmark inbound JSON; Mailgun-style keys (`body-mime`, `body-plain`, `body-html`, `message-headers`, `recipient`); or `{ "raw": "<rfc822>", "recipient": "…" }` |
| `application/x-www-form-urlencoded`, `multipart/form-data` | Mailgun route "forward" (parsed or `body-mime`); uploaded files are ignored |

Responses:

| Status | Meaning |
|---|---|
| `200` `{ok, status}` | processed. `status` is `created`, `duplicate`, or a dropped mail (`unknown-token`, `inactive`, `no-token`, `rate-limited`, `parse-error`) — dropped mail is **not** retried or bounced, to avoid backscatter |
| `400` / `415` | unreadable JSON / unsupported content type |
| `401` | missing or wrong signature / password; `timestamp-out-of-window` when the (authentic) request is more than 5 minutes off |
| `403` | the source is paused (Postmark stops retrying on 403) |
| `404` | unknown source id, or the source is not a webhook way |
| `413` | body or mail larger than the limit (raw mail 10 MB; JSON may be ~4/3 larger for base64 attachments) |
| `429` | rate limit |
| `500` / `503` | infrastructure error / no readable secret — the sender should retry |

## Security notes

- **Signature:** HMAC-SHA256 over `timestamp \n recipient \n body`, compared in constant time.
  The ±5 minute window is only evaluated for authentic requests. A replay inside the window is
  harmless: mails are de-duplicated by Message-ID.
- **Rate limits (per source and client IP):** 60 requests per minute; 10 failed authentications
  per 5 minutes lock that client out for the rest of the window. Failed attempts never write
  to the database. Behind a reverse proxy set `TRUSTED_PROXY_COUNT` correctly so the real client
  address is used.
- **Limits:** the request body is read with a hard cap (Content-Length is not trusted); a paused
  source answers 403 before the body is read. Attachments are never stored; only inline raster images
  up to 2 MB are kept.
- **Secrets at rest:** the secret is stored sealed (`ff2.` format, purpose
  `inboundMailSource.webhookSecret`), is returned to the browser exactly once when it is created
  and is never logged. Neither mail bodies, subjects, sender addresses nor headers are logged — only
  ids and status codes.
- **Authentication results:** the webhook ways do not trust `Authentication-Results` headers (there
  is no provider-verified authserv-id), so the "sender verified" badge stays off for these mails.
- **Rotation:** "Change setup / new secret" in the status card replaces the secret and invalidates the
  old Worker script / URL immediately; addresses stay the same. "Disconnect" wipes the secret.

## IMAP

See the wizard (Admin → Server settings → Newsletter). FeedFerret reads only mail whose
recipient carries a valid `+ff-<token>`, files it into the IMAP folder `FeedFerret` (fallback: marks it as read
and flagged) and leaves everything else untouched. Use a mailbox dedicated to newsletters.
