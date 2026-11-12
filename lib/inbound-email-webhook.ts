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
//     and is compared in constant time.
//   - Rate limits are keyed by the client alone, NOT by source id: the id comes
//     from the URL (attacker-chosen), and one entry per random id would let a
//     flood evict other limiters (sign-in lockout) from the shared store. 60
//     requests/min; failed authentications are counted (10 per 5 min, then 429
//     instead of 401). A request that authenticates is never locked out. Failed
//     attempts never write to the DB.
//   - Credentials are checked before the body is buffered wherever possible
//     (Basic fully; signature: format + timestamp window). At most
//     MAX_CONCURRENT_WEBHOOK_REQUESTS bodies are buffered at once (503 +
//     Retry-After beyond that), the body is capped while streaming
//     (Content-Length is not trusted) and a stalled body is cut off after
//     BODY_TIMEOUT_MS.
//   - A paused/disconnected source answers 403 before the body is read.
//   - Logs carry ids and status codes only — never bodies, headers or secrets.

import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { db } from "@/lib/db";
import { logger } from "@/lib/logger";
import { readPlainColumnState, sealSecret } from "@/lib/secret-box";
import { checkRateLimit, getClientIdentifier, peekRateLimit, rateLimitHeaders, RATE_LIMITS } from "@/lib/rate-limit";
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
/** Bodies buffered at the same time, instance-wide (13 MB each): the rest gets 503. */
export const MAX_CONCURRENT_WEBHOOK_REQUESTS = 4;
/** A body that has not fully arrived by then is dropped (slow-loris). */
export const BODY_TIMEOUT_MS = 30_000;
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

export class BodyTimeoutError extends Error {
  constructor() {
    super("request body timed out");
    this.name = "BodyTimeoutError";
  }
}

/** Reads at most `limit` bytes; null when the body is (or declares itself) larger; throws BodyTimeoutError when it stalls. */
export async function readBodyCapped(request: Request, limit: number, timeoutMs = BODY_TIMEOUT_MS): Promise<Buffer | null> {
  const declared = Number(request.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > limit) return null;
  if (!request.body) return Buffer.alloc(0);
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    void reader.cancel().catch(() => undefined);
  }, timeoutMs);
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (timedOut) throw new BodyTimeoutError();
      if (done) break;
      total += value.byteLength;
      if (total > limit) {
        await reader.cancel().catch(() => undefined);
        return null;
      }
      chunks.push(value);
    }
  } catch (error) {
    if (timedOut) throw new BodyTimeoutError();
    throw error;
  } finally {
    clearTimeout(timer);
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

/** Bodies one client may have in flight; with a global cap of 4 this keeps a single IP from holding every slot. */
export const MAX_CONCURRENT_PER_CLIENT = 1;
let inFlight = 0;
const inFlightByClient = new Map<string, number>();
/** Webhook requests currently holding a body slot (tests). */
export const inFlightWebhookRequests = () => inFlight;

const SIGNATURE_FORMAT_RE = /^(?:sha256=)?[0-9a-f]{64}$/i;

type AuthFailed = (error: string, status?: number, extra?: HeadersInit) => Response;

export async function handleInboundEmailWebhook(request: Request, sourceId: string): Promise<Response> {
  if (!SOURCE_ID_RE.test(sourceId)) return reply(404, { error: "not-found" });

  // Keyed by the client alone: the source id comes from the URL, i.e. from the attacker.
  const client = getClientIdentifier(request);
  const limited = checkRateLimit(client, RATE_LIMITS.inboundEmailWebhook);
  if (!limited.success) return reply(429, { error: "rate-limited" }, rateLimitHeaders(limited));
  // Counts a failure (check + increment in one step); once the budget is
  // spent the answer turns into 429. Used for failed authentications and, in
  // signature mode, for bodies that never arrive / are too large.
  const spend = () => checkRateLimit(client, RATE_LIMITS.inboundEmailWebhookAuthFail);
  const authFailed: AuthFailed = (error, status = 401, extra = {}) => {
    const budget = spend();
    logger.warn("[inbound-email-webhook] rejected", { sourceId, reason: error });
    if (!budget.success) return reply(429, { error: "too-many-failed-attempts" }, rateLimitHeaders(budget));
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

  // Everything that can be checked without the body is checked first.
  const recipientHeader = request.headers.get(RECIPIENT_HEADER);
  const signature = request.headers.get(SIGNATURE_HEADER);
  const authorization = request.headers.get("authorization");
  const timestamp = request.headers.get(TIMESTAMP_HEADER);
  const mode: "signature" | "basic" | null = signature ? "signature" : authorization ? "basic" : null;
  if (mode === null) return authFailed("unauthorized", 401, { "www-authenticate": 'Basic realm="FeedFerret inbound email"' });
  if (mode === "basic" && !verifyBasicSecret(authorization, secret)) return authFailed("invalid-credentials");
  if (mode === "signature") {
    const ts = (timestamp ?? "").trim();
    if (!SIGNATURE_FORMAT_RE.test((signature ?? "").trim()) || !/^\d{1,12}$/.test(ts)) return authFailed("invalid-signature");
    if (Math.abs(Math.floor(Date.now() / 1000) - Number(ts)) > SIGNATURE_TOLERANCE_SECS) return authFailed("timestamp-out-of-window");
  }

  // A signature cannot be verified before the body is read, so a client that
  // already spent its failure budget gets no more body slots (Basic was verified above).
  if (mode === "signature") {
    const budget = peekRateLimit(client, RATE_LIMITS.inboundEmailWebhookAuthFail);
    if (!budget.success) return reply(429, { error: "too-many-failed-attempts" }, rateLimitHeaders({ ...budget, retryAfterSecs: Math.ceil((budget.resetAt - Date.now()) / 1000) }));
  }

  // Bounded memory: a few (up to 13 MB) bodies at once, instance-wide, and one
  // per client, so that one address cannot occupy every slot.
  if (inFlight >= MAX_CONCURRENT_WEBHOOK_REQUESTS || (inFlightByClient.get(client) ?? 0) >= MAX_CONCURRENT_PER_CLIENT) {
    return reply(503, { error: "busy" }, { "retry-after": "5" });
  }
  inFlight += 1;
  inFlightByClient.set(client, (inFlightByClient.get(client) ?? 0) + 1);
  try {
    return await processBody(request, { sourceId, secret, mode, signature, timestamp, recipientHeader, authFailed, spend });
  } finally {
    inFlight -= 1;
    const left = (inFlightByClient.get(client) ?? 1) - 1;
    if (left > 0) inFlightByClient.set(client, left);
    else inFlightByClient.delete(client);
  }
}

async function processBody(
  request: Request,
  ctx: {
    sourceId: string;
    secret: string;
    mode: "signature" | "basic";
    signature: string | null;
    timestamp: string | null;
    recipientHeader: string | null;
    authFailed: AuthFailed;
    spend: () => unknown;
  },
): Promise<Response> {
  const { sourceId, secret, mode, signature, timestamp, recipientHeader, authFailed, spend } = ctx;
  // Unverified (signature) requests that stall, break or overflow count like failed logins.
  const bodyFailure = (status: number, error: string) => {
    if (mode === "signature") spend();
    return reply(status, { error });
  };
  let body: Buffer | null;
  try {
    body = await readBodyCapped(request, MAX_WEBHOOK_BODY_BYTES);
  } catch (error) {
    if (error instanceof BodyTimeoutError) return bodyFailure(408, "request-timeout");
    return bodyFailure(400, "unreadable-body");
  }
  if (body === null) return bodyFailure(413, "payload-too-large");

  if (mode === "signature") {
    const verdict = verifyInboundSignature({ secret, signatureHeader: signature, timestampHeader: timestamp, recipient: recipientHeader ?? "", body });
    if (verdict === "stale") return authFailed("timestamp-out-of-window");
    if (verdict !== "ok") return authFailed("invalid-signature");
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
    if (result.userId && result.articleId) {
      // The mail is stored: a failing side effect must not turn this into a 500 (the sender would retry).
      try {
        await afterIngest([{ userId: result.userId, articleId: result.articleId }], "inbound-email-webhook");
      } catch (error) {
        logger.error("[inbound-email-webhook] after-ingest hooks failed", { sourceId, error: error instanceof Error ? error.name : "error" });
      }
    }
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
