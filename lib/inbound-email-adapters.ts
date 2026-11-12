// N1 PR C: payload adapters for the inbound-email webhook.
//
// Every adapter ends in one thing: a raw RFC 822 message plus the envelope
// recipients, which `ingestRawEmail` (shared with the IMAP poller) consumes.
//   - Cloudflare Email Worker / generic relays: the body IS the raw message.
//   - Postmark inbound JSON, Mailgun route forwards (form or JSON): the parts
//     the provider already parsed are rebuilt into a small MIME message
//     (headers, text, html, inline images). Attachments are not forwarded:
//     the ingest drops them anyway.
//
// Nothing here fetches anything, logs anything or trusts a size field of the
// payload; the caller has already capped the body.

import { randomBytes } from "node:crypto";

export type InboundFormat = "rfc822" | "postmark" | "mailgun";

export type AdaptResult =
  | { ok: true; format: InboundFormat; raw: Buffer | string; recipients: string[] }
  | { ok: false; error: "unsupported-content-type" | "invalid-json" | "invalid-payload" };

const MAX_RECIPIENTS = 20;
const MAX_HEADER_VALUE = 4_000;
/** Spec §6.2: inline images up to 2 MB (base64 is ~4/3 of that). */
const MAX_INLINE_BASE64 = Math.ceil((2 * 1024 * 1024 * 4) / 3);
const INLINE_IMAGE_TYPES = new Set(["image/png", "image/jpeg", "image/jpg", "image/gif", "image/webp"]);
/** Rebuilt from the parsed parts, so the provider's own structure headers must not leak through. */
const STRUCTURE_HEADERS = new Set(["content-type", "content-transfer-encoding", "content-disposition", "content-length", "content-id", "mime-version"]);
const HEADER_NAME_RE = /^[\x21-\x39\x3b-\x7e]{1,100}$/;

type HeaderPair = [name: string, value: string];
type InlineImage = { cid: string; contentType: string; base64: string };

// ---------------------------------------------------------------------------
// Small helpers

function asString(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** A header value never carries a line break (no header injection from JSON/form fields). */
function cleanHeaderValue(value: string): string {
  return value.split(/[\r\n]+/).join(" ").trim().slice(0, MAX_HEADER_VALUE);
}

function pushRecipients(into: string[], ...values: unknown[]) {
  for (const value of values) {
    if (into.length >= MAX_RECIPIENTS) return;
    const text = asString(value);
    if (text) into.push(cleanHeaderValue(text));
  }
}

function fullEmails(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.map((entry) => (isRecord(entry) ? asString(entry.Email) : null)).filter((email): email is string => !!email);
}

function bareCid(value: unknown): string | null {
  const text = asString(value);
  if (!text) return null;
  const cid = text.trim().replace(/^cid:/i, "").replace(/^</, "").replace(/>$/, "");
  return cid && cid.length <= 300 && !/[\s<>"]/.test(cid) ? cid : null;
}

function wrapBase64(flat: string): string {
  const lines: string[] = [];
  for (let i = 0; i < flat.length; i += 76) lines.push(flat.slice(i, i + 76));
  return lines.join("\r\n");
}

const base64Lines = (buffer: Buffer) => wrapBase64(buffer.toString("base64"));

// ---------------------------------------------------------------------------
// MIME builder

interface Part {
  headers: string[];
  body: string;
}

const serialize = (part: Part) => `${part.headers.join("\r\n")}\r\n\r\n${part.body}`;

function leaf(contentType: string, body: string): Part {
  return {
    headers: [`Content-Type: ${contentType}; charset=utf-8`, "Content-Transfer-Encoding: base64"],
    body: base64Lines(Buffer.from(body, "utf8")),
  };
}

function multipart(subtype: "alternative" | "related", parts: Part[]): Part {
  const boundary = `ff-${randomBytes(12).toString("hex")}`;
  return {
    headers: [`Content-Type: multipart/${subtype}; boundary="${boundary}"`],
    body: `${parts.map((p) => `--${boundary}\r\n${serialize(p)}\r\n`).join("")}--${boundary}--\r\n`,
  };
}

function imagePart(image: InlineImage): Part {
  return {
    headers: [
      `Content-Type: ${image.contentType}`,
      "Content-Transfer-Encoding: base64",
      `Content-ID: <${image.cid}>`,
      "Content-Disposition: inline",
    ],
    body: wrapBase64(image.base64.split(/\s+/).join("")),
  };
}

export function buildMime(input: { headers: HeaderPair[]; text: string | null; html: string | null; inline?: InlineImage[] }): string | null {
  const top: string[] = [];
  for (const [name, value] of input.headers) {
    if (!HEADER_NAME_RE.test(name) || STRUCTURE_HEADERS.has(name.toLowerCase())) continue;
    const clean = cleanHeaderValue(value);
    if (clean) top.push(`${name}: ${clean}`);
  }
  const inline = (input.inline ?? []).filter((i) => INLINE_IMAGE_TYPES.has(i.contentType) && i.base64.length <= MAX_INLINE_BASE64);

  let body: Part;
  if (input.html) {
    const html = inline.length > 0 ? multipart("related", [leaf("text/html", input.html), ...inline.map(imagePart)]) : leaf("text/html", input.html);
    body = input.text ? multipart("alternative", [leaf("text/plain", input.text), html]) : html;
  } else if (input.text) {
    body = leaf("text/plain", input.text);
  } else {
    return null;
  }
  return `${[...top, "MIME-Version: 1.0", ...body.headers].join("\r\n")}\r\n\r\n${body.body}`;
}

// ---------------------------------------------------------------------------
// Postmark (inbound webhook JSON)

function adaptPostmark(payload: Record<string, unknown>): AdaptResult {
  const recipients: string[] = [];
  pushRecipients(recipients, payload.OriginalRecipient, ...fullEmails(payload.ToFull), ...fullEmails(payload.CcFull), payload.To);

  // "Include raw email content in JSON payload" is enabled on the server: use it as is.
  const rawEmail = asString(payload.RawEmail);
  if (rawEmail) return { ok: true, format: "postmark", raw: rawEmail, recipients };

  const headers: HeaderPair[] = [];
  const present = new Set<string>();
  if (Array.isArray(payload.Headers)) {
    for (const entry of payload.Headers) {
      if (!isRecord(entry)) continue;
      const name = asString(entry.Name);
      const value = typeof entry.Value === "string" ? entry.Value : null;
      if (!name || value === null) continue;
      headers.push([name, value]);
      present.add(name.toLowerCase());
    }
  }
  const fallback: [string, unknown][] = [
    ["From", payload.From],
    ["To", payload.To],
    ["Cc", payload.Cc],
    ["Subject", payload.Subject],
    ["Date", payload.Date],
  ];
  for (const [name, value] of fallback) {
    const text = asString(value);
    if (text && !present.has(name.toLowerCase())) headers.push([name, text]);
  }
  // The JSON's MessageID is Postmark's own id; still a stable dedupe key when the original has none.
  const postmarkId = asString(payload.MessageID);
  if (postmarkId && !present.has("message-id") && /^[\w.-]{8,100}$/.test(postmarkId)) headers.push(["Message-ID", `<${postmarkId}@inbound.postmarkapp.com>`]);

  const inline: InlineImage[] = [];
  if (Array.isArray(payload.Attachments)) {
    for (const attachment of payload.Attachments) {
      if (!isRecord(attachment)) continue;
      const cid = bareCid(attachment.ContentID);
      const contentType = asString(attachment.ContentType)?.toLowerCase().split(";")[0].trim();
      const content = asString(attachment.Content);
      if (cid && contentType && content) inline.push({ cid, contentType, base64: content });
    }
  }

  const raw = buildMime({ headers, text: asString(payload.TextBody), html: asString(payload.HtmlBody), inline });
  return raw ? { ok: true, format: "postmark", raw, recipients } : { ok: false, error: "invalid-payload" };
}

// ---------------------------------------------------------------------------
// Mailgun (route "forward": form fields or JSON with the same keys)

function field(fields: Record<string, unknown>, ...names: string[]): string | null {
  for (const name of names) {
    const value = asString(fields[name]);
    if (value) return value;
  }
  return null;
}

function adaptMailgun(fields: Record<string, unknown>): AdaptResult {
  const recipients: string[] = [];
  pushRecipients(recipients, ...(field(fields, "recipient", "Recipient") ?? "").split(","), field(fields, "To", "to"));

  // A route that delivers the whole MIME message (`body-mime`) needs no rebuilding.
  const mime = field(fields, "body-mime");
  if (mime) return { ok: true, format: "mailgun", raw: mime, recipients };

  const headers: HeaderPair[] = [];
  const present = new Set<string>();
  const messageHeaders = field(fields, "message-headers");
  if (messageHeaders) {
    try {
      const parsed: unknown = JSON.parse(messageHeaders);
      if (Array.isArray(parsed)) {
        for (const pair of parsed) {
          if (!Array.isArray(pair) || typeof pair[0] !== "string" || typeof pair[1] !== "string") continue;
          headers.push([pair[0], pair[1]]);
          present.add(pair[0].toLowerCase());
        }
      }
    } catch {
      /* the plain fields below still make a usable message */
    }
  }
  const fallback: [string, string | null][] = [
    ["From", field(fields, "From", "from", "sender")],
    ["To", field(fields, "To", "to", "recipient")],
    ["Subject", field(fields, "Subject", "subject")],
    ["Date", field(fields, "Date", "date")],
    ["Message-ID", field(fields, "Message-Id", "message-id")],
  ];
  for (const [name, value] of fallback) {
    if (value && !present.has(name.toLowerCase())) headers.push([name, value]);
  }

  const raw = buildMime({ headers, text: field(fields, "body-plain"), html: field(fields, "body-html") });
  return raw ? { ok: true, format: "mailgun", raw, recipients } : { ok: false, error: "invalid-payload" };
}

// ---------------------------------------------------------------------------
// Dispatcher

function adaptJson(value: unknown): AdaptResult {
  if (!isRecord(value)) return { ok: false, error: "invalid-payload" };
  if (value.HtmlBody !== undefined || value.TextBody !== undefined || value.RawEmail !== undefined || value.FromFull !== undefined) return adaptPostmark(value);
  if (value["body-html"] !== undefined || value["body-plain"] !== undefined || value["body-mime"] !== undefined || value["message-headers"] !== undefined) return adaptMailgun(value);
  // Minimal relay shape: { raw: "<rfc822>", recipient?: "…" | ["…"] }.
  const raw = asString(value.raw);
  if (raw) {
    const recipients: string[] = [];
    pushRecipients(recipients, ...(Array.isArray(value.recipient) ? value.recipient : [value.recipient]));
    return { ok: true, format: "rfc822", raw, recipients };
  }
  return { ok: false, error: "invalid-payload" };
}

/**
 * Turns a (size-capped, already authenticated) webhook body into a raw message.
 * `envelopeRecipient` is the signed `X-FeedFerret-Recipient` of the Cloudflare worker.
 */
export async function adaptInboundPayload(contentType: string | null, body: Buffer, envelopeRecipient: string | null): Promise<AdaptResult> {
  const type = (contentType ?? "").split(";")[0].trim().toLowerCase();
  if (body.byteLength === 0) return { ok: false, error: "invalid-payload" };

  if (type === "message/rfc822" || type === "text/plain" || type === "application/octet-stream") {
    const recipients: string[] = [];
    pushRecipients(recipients, envelopeRecipient);
    return { ok: true, format: "rfc822", raw: body, recipients };
  }

  if (type === "application/json") {
    let parsed: unknown;
    try {
      parsed = JSON.parse(body.toString("utf8"));
    } catch {
      return { ok: false, error: "invalid-json" };
    }
    const result = adaptJson(parsed);
    if (result.ok && envelopeRecipient) pushRecipients(result.recipients, envelopeRecipient);
    return result;
  }

  if (type === "application/x-www-form-urlencoded" || type === "multipart/form-data") {
    let form: FormData;
    try {
      form = await new Response(new Blob([new Uint8Array(body)]), { headers: { "content-type": contentType ?? type } }).formData();
    } catch {
      return { ok: false, error: "invalid-payload" };
    }
    const fields: Record<string, unknown> = {};
    for (const [key, value] of form.entries()) {
      if (typeof value === "string" && !(key in fields)) fields[key] = value; // attachments (File) are dropped
    }
    const result = adaptMailgun(fields);
    if (result.ok && envelopeRecipient) pushRecipients(result.recipients, envelopeRecipient);
    return result;
  }

  return { ok: false, error: "unsupported-content-type" };
}
