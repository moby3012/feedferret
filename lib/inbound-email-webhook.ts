// N1 PR C: inbound-email webhook (spec §10 / PR C).
//
// POST /api/webhooks/inbound-email/<sourceId> accepts one mail per request from
//   - the Cloudflare Email Worker the wizard generates (raw RFC 822, HMAC-signed),
//   - any relay that can sign the same way, and
//   - Postmark / Mailgun inbound webhooks (JSON / form), which cannot sign: they
//     authenticate with the secret as HTTP Basic password in the webhook URL.
// and feeds `ingestRawEmail` — the very same path as the IMAP poller, so
// recipient-token routing, sanitizing, dedupe, daily quota and the double-opt-in
// banner behave identically.
//
// Security model:
//   - The signature covers `timestamp \n recipient \n body` (HMAC-SHA256, hex)
//     and is compared in constant time; only a valid signature can be "stale"
//     (±5 min), so the response never tells an outsider anything about the key.
//   - Per source + client IP: 60 requests/min, and 10 failed authentications per
//     5 min lock further attempts out. Failed attempts never write to the DB.
//   - The body is capped while streaming (Content-Length is not trusted).
//   - A paused/disconnected source answers 403 before the body is read.
//   - Logs carry ids and status codes only — never bodies, headers or secrets.

import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { db } from "@/lib/db";
import { logger } from "@/lib/logger";
import { readPlainColumnState, sealSecret } from "@/lib/secret-box";
import { checkRateLimit, consumeRateLimit, getClientIdentifier, peekRateLimit, rateLimitHeaders, RATE_LIMITS } from "@/lib/rate-limit";
import { ingestRawEmail, MAX_RAW_EMAIL_BYTES, type IngestResult } from "@/lib/inbound-email";
import { adaptInboundPayload } from "@/lib/inbound-email-adapters";
import { afterIngest } from "@/lib/newsletter-after-ingest";
import { isWebhookKind } from "@/lib/newsletter-constants";

export const WEBHOOK_SECRET_PURPOSE = "inboundMailSource.webhookSecret";
export const SIGNATURE_HEADER = "x-feedferret-signature";
export const TIMESTAMP_HEADER = "x-feedferret-timestamp";
export const RECIPIENT_HEADER = "x-feedferret-recipient";
/** Allowed clock difference between sender and server (replay window). */
export const SIGNATURE_TOLERANCE_SECS = 5 * 60;
/** Raw mail limit (10 MB) plus base64 inflation for JSON payloads with attachments. */
export const MAX_WEBHOOK_BODY_BYTES = Math.ceil((MAX_RAW_EMAIL_BYTES * 4) / 3) + 64 * 1024;

const SOURCE_ID_RE = /^[a-z0-9_-]{8,64}$/i;
const SIGNATURE_RE = /^(?:sha256=)?([0-9a-f]{64})$/i;

// ---------------------------------------------------------------------------
// Secret

/** 256-bit random secret, hex (URL- and copy-safe). Shown to the admin once. */
export function generateWebhookSecret(): string {
  return randomBytes(32).toString("hex");
}

export function sealWebhookSecret(secret: string): string {
  return sealSecret(WEBHOOK_SECRET_PURPOSE, secret);
}

/** The plain secret, or null when absent/unreadable (wrong key: logged once by secret-box, never the value). */
export function openWebhookSecret(stored: string | null | undefined): string | null {
  return readPlainColumnState(WEBHOOK_SECRET_PURPOSE, stored).value;
}

// ---------------------------------------------------------------------------
// Signature

export function signInboundBody(secret: string, timestamp: string, recipient: string, body: Uint8Array): string {
  return createHmac("sha256", secret).update(`${timestamp}\n${recipient}\n`).update(body).digest("hex");
}

export type SignatureVerdict = "ok" | "invalid" | "stale";

export function verifyInboundSignature(input: {
  secret: string;
  signatureHeader: string | null;
  timestampHeader: string | null;
  recipient: string;
  body: Uint8Array;
  /** Unix seconds; default now. */
  nowSecs?: number;
}): SignatureVerdict {
  const match = SIGNATURE_RE.exec((input.signatureHeader ?? "").trim());
  const timestamp = (input.timestampHeader ?? "").trim();
  if (!match || timestamp.length === 0 || timestamp.length > 20) return "invalid";
  const expected = Buffer.from(signInboundBody(input.secret, timestamp, input.recipient, input.body), "hex");
  const actual = Buffer.from(match[1], "hex");
  if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) return "invalid";
  // Only an authentic request learns about the time window.
  const sent = /^\d{1,12}$/.test(timestamp) ? Number(timestamp) : Number.NaN;
  const now = input.nowSecs ?? Math.floor(Date.now() / 1000);
  return Number.isFinite(sent) && Math.abs(now - sent) <= SIGNATURE_TOLERANCE_SECS ? "ok" : "stale";
}

const digest = (value: string) => createHash("sha256").update(value).digest();

/** `Authorization: Basic base64(user:secret)` — the user part is ignored, the password must be the secret. */
export function verifyBasicSecret(authorization: string | null, secret: string): boolean {
  const match = /^Basic\s+([A-Za-z0-9+/=_-]{1,2000})$/i.exec((authorization ?? "").trim());
  if (!match) return false;
  const decoded = Buffer.from(match[1], "base64").toString("utf8");
  const password = decoded.slice(decoded.indexOf(":") + 1);
  // Hashing first makes the comparison length-independent.
  return timingSafeEqual(digest(password), digest(secret));
}

// ---------------------------------------------------------------------------
// Body

/** Reads at most `limit` bytes; null when the body is (or declares itself) larger. */
export async function readBodyCapped(request: Request, limit: number): Promise<Buffer | null> {
  const declared = Number(request.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > limit) return null;
  if (!request.body) return Buffer.alloc(0);
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > limit) {
      await reader.cancel().catch(() => undefined);
      return null;
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks, total);
}

// ---------------------------------------------------------------------------
// Handler

const reply = (status: number, body: Record<string, unknown>, headers: HeadersInit = {}) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", "cache-control": "no-store", ...headers } });

const bookkeeping = (sourceId: string, data: Record<string, unknown>) =>
  db.inboundMailSource.update({ where: { id: sourceId }, data }).catch(() => {
    logger.warn("[inbound-email-webhook] source bookkeeping failed", { sourceId });
  });

/** Stored in `InboundMailSource.lastError` (wizard maps them to copy). */
export type WebhookErrorCode = "mail-unparseable" | "mail-too-large" | "payload-unsupported";

export async function handleInboundEmailWebhook(request: Request, sourceId: string): Promise<Response> {
  if (!SOURCE_ID_RE.test(sourceId)) return reply(404, { error: "not-found" });

  const client = `${sourceId}:${getClientIdentifier(request)}`;
  const limited = checkRateLimit(client, RATE_LIMITS.inboundEmailWebhook);
  if (!limited.success) return reply(429, { error: "rate-limited" }, rateLimitHeaders(limited));
  const lockout = peekRateLimit(client, RATE_LIMITS.inboundEmailWebhookAuthFail);
  if (!lockout.success) return reply(429, { error: "too-many-failed-attempts" }, rateLimitHeaders({ ...lockout, retryAfterSecs: Math.ceil((lockout.resetAt - Date.now()) / 1000) }));
  const authFailed = (error: string, status = 401, extra: HeadersInit = {}) => {
    consumeRateLimit(client, RATE_LIMITS.inboundEmailWebhookAuthFail, 1);
    logger.warn("[inbound-email-webhook] rejected", { sourceId, reason: error });
    return reply(status, { error }, extra);
  };

  const source = await db.inboundMailSource.findUnique({ where: { id: sourceId }, select: { id: true, kind: true, paused: true, webhookSecret: true } });
  if (!source || !isWebhookKind(source.kind)) return authFailed("not-found", 404);
  // Before the body is read: a disabled source costs nothing. 403 also tells
  // Postmark to stop retrying.
  if (source.paused) return reply(403, { error: "source-disabled" });
  const secret = openWebhookSecret(source.webhookSecret);
  if (!secret) {
    logger.warn("[inbound-email-webhook] source has no readable secret", { sourceId });
    return reply(503, { error: "source-not-configured" });
  }

  const body = await readBodyCapped(request, MAX_WEBHOOK_BODY_BYTES).catch(() => undefined);
  if (body === undefined) return reply(400, { error: "unreadable-body" });
  if (body === null) return reply(413, { error: "payload-too-large" });

  const recipientHeader = request.headers.get(RECIPIENT_HEADER);
  const signature = request.headers.get(SIGNATURE_HEADER);
  const authorization = request.headers.get("authorization");
  if (signature) {
    const verdict = verifyInboundSignature({
      secret,
      signatureHeader: signature,
      timestampHeader: request.headers.get(TIMESTAMP_HEADER),
      recipient: recipientHeader ?? "",
      body,
    });
    if (verdict === "stale") return authFailed("timestamp-out-of-window");
    if (verdict !== "ok") return authFailed("invalid-signature");
  } else if (authorization) {
    if (!verifyBasicSecret(authorization, secret)) return authFailed("invalid-credentials");
  } else {
    return authFailed("unauthorized", 401, { "www-authenticate": 'Basic realm="FeedFerret inbound email"' });
  }

  const adapted = await adaptInboundPayload(request.headers.get("content-type"), body, recipientHeader);
  if (!adapted.ok) {
    await bookkeeping(sourceId, { errorCount: { increment: 1 }, lastError: "payload-unsupported" satisfies WebhookErrorCode, lastCheckedAt: new Date() });
    logger.warn("[inbound-email-webhook] payload not understood", { sourceId, reason: adapted.error });
    return reply(adapted.error === "unsupported-content-type" ? 415 : 400, { error: adapted.error });
  }

  let result: IngestResult;
  try {
    result = await ingestRawEmail(adapted.raw, { recipients: adapted.recipients, receivedAt: new Date() });
  } catch (error) {
    // Infrastructure failure (DB down): the sender retries.
    logger.error("[inbound-email-webhook] ingest failed", { sourceId, error: error instanceof Error ? error.name : "error" });
    return reply(500, { error: "ingest-failed" });
  }

  const now = new Date();
  if (result.status === "created") {
    await bookkeeping(sourceId, { lastReceivedAt: now, lastCheckedAt: now, errorCount: 0, lastError: null });
    if (result.userId && result.articleId) await afterIngest([{ userId: result.userId, articleId: result.articleId }], "inbound-email-webhook");
  } else if (result.status === "parse-error" || result.status === "too-large") {
    const code: WebhookErrorCode = result.status === "parse-error" ? "mail-unparseable" : "mail-too-large";
    await bookkeeping(sourceId, { errorCount: { increment: 1 }, lastError: code, lastCheckedAt: now });
  } else {
    await bookkeeping(sourceId, { lastCheckedAt: now });
  }

  // Mail for unknown / revoked addresses is accepted and dropped: a retry or a
  // bounce would only turn into backscatter.
  if (result.status === "too-large") return reply(413, { error: "payload-too-large" });
  return reply(200, { ok: true, status: result.status, format: adapted.format });
}
