// N1 newsletter-to-feed core (spec .pm/spec-n1-newsletter.md §3–§6, Revision 2 PR A).
//
// `ingestRawEmail` turns one raw RFC 822 message into one normal Article row in a
// newsletter Feed (sourceType "newsletter"), so it shows up in the app and in
// GReader / Fever / FreshRSS clients like any other feed item. Transports (IMAP
// poller, webhook) live elsewhere and only call this function.
//
// Rules:
// - The recipient token is the only thing that routes a mail to a user.
// - HTML always ends in the shared DOMPurify pipeline (lib/sanitize-html.ts);
//   before that, tracking pixels / hidden blocks are removed, `cid:` images are
//   inlined (raster only, size-capped) and tracking params are stripped from links.
// - Attachments are dropped. Nothing is fetched and no link is ever opened here
//   (double-opt-in and List-Unsubscribe are stored as metadata only).
// - An existing row (same Message-ID) is never rewritten: no Article.updatedAt bump.
// - Logs carry metadata only (ids, status) — never subject, sender or body.

import { createHash, randomBytes } from "crypto";
import { JSDOM } from "jsdom";
import PostalMime from "postal-mime";
import { db } from "./db";
import { getSanitizer } from "./sanitize-html";
import { computeArticleMeta, htmlToPlainText } from "./article-kind";
import { computeContentHash } from "./content-hash";
import { logger } from "./logger";

import { NEWSLETTER_CATEGORY_NAME, NEWSLETTER_FEED_URL_PREFIX, NEWSLETTER_SOURCE_TYPE } from "./newsletter-constants";

export { NEWSLETTER_CATEGORY_NAME, NEWSLETTER_FEED_URL_PREFIX, NEWSLETTER_SOURCE_TYPE };

/** Spec §6.2: larger raw mails are rejected (webhook answers 413). */
export const MAX_RAW_EMAIL_BYTES = 10 * 1024 * 1024;
/** HTML bodies are cut before sanitizing (DOMPurify re-balances the markup). */
const MAX_HTML_CHARS = 2_000_000;
const MAX_TEXT_CHARS = 500_000;
/** Inline (`cid:`) raster images become data: URIs up to these caps; others are dropped. */
const MAX_INLINE_IMAGE_BYTES = 512 * 1024;
const MAX_INLINE_TOTAL_BYTES = 2 * 1024 * 1024;
const INLINE_IMAGE_TYPES = new Set(["image/png", "image/jpeg", "image/jpg", "image/gif", "image/webp"]);
/** Spec §6.3: mailbombing guard per user and rolling day. */
export const MAX_NEWSLETTER_MAILS_PER_DAY = 200;

// ---------------------------------------------------------------------------
// Tokens & addresses

const TOKEN_ALPHABET = "abcdefghijklmnopqrstuvwxyz234567"; // RFC 4648 base32, lowercase
const TOKEN_LENGTH = 26; // 26 × 5 bit = 130 bit
const TOKEN_RE = /^[a-z2-7]{26}$/;
const PLUS_TOKEN_RE = /\+ff-([a-z2-7]{26})(?![a-z2-7])/;

/** Unguessable 130-bit base32 token for a NewsletterAddress. */
export function generateNewsletterToken(): string {
  const bytes = randomBytes(TOKEN_LENGTH);
  let out = "";
  for (let i = 0; i < TOKEN_LENGTH; i++) out += TOKEN_ALPHABET[bytes[i] & 31];
  return out;
}

export function isNewsletterToken(value: string): boolean {
  return TOKEN_RE.test(value);
}

/**
 * The address a user hands to newsletters. IMAP sources use plus-addressing on
 * the shared mailbox (`box+ff-<token>@host`); domain sources use `<token>@domain`.
 */
export function newsletterAddressFor(source: { kind: string; address: string | null }, token: string): string | null {
  const base = source.address?.trim().toLowerCase();
  if (!base) return null;
  if (source.kind === "imap") {
    const at = base.lastIndexOf("@");
    if (at <= 0) return null;
    const local = base.slice(0, at).split("+")[0];
    return `${local}+ff-${token}@${base.slice(at + 1)}`;
  }
  const domain = base.includes("@") ? base.slice(base.lastIndexOf("@") + 1) : base;
  return `${token}@${domain}`;
}

const ADDRESS_RE = /[^\s<>"',;:()[\]]+@[^\s<>"',;:()[\]]+/g;

/**
 * Candidate tokens in recipient strings ("Name <a@b>", bare addresses, lists).
 * Supports `local+ff-<token>@host` and `<token>@domain` / `<token>+tag@domain`.
 */
export function extractRecipientTokens(recipients: readonly string[]): string[] {
  const tokens: string[] = [];
  for (const recipient of recipients) {
    for (const address of String(recipient).toLowerCase().match(ADDRESS_RE) ?? []) {
      const local = address.slice(0, address.lastIndexOf("@"));
      const plus = PLUS_TOKEN_RE.exec(local);
      const token = plus ? plus[1] : local.split("+")[0];
      if (TOKEN_RE.test(token) && !tokens.includes(token)) tokens.push(token);
    }
  }
  return tokens;
}

// ---------------------------------------------------------------------------
// Header helpers

type ParsedEmail = Awaited<ReturnType<typeof PostalMime.parse>>;

function header(email: ParsedEmail, name: string): string | null {
  const found = email.headers.find((h) => h.key === name);
  return found ? found.value : null;
}

function headerAll(email: ParsedEmail, name: string): string[] {
  return email.headers.filter((h) => h.key === name).map((h) => h.value);
}

function mailbox(address: ParsedEmail["from"]): { name: string; address: string } | null {
  if (!address) return null;
  if (address.address) return { name: address.name || "", address: address.address.toLowerCase() };
  const first = address.group?.[0];
  return first?.address ? { name: first.name || "", address: first.address.toLowerCase() } : null;
}

/** Message-ID without brackets/whitespace; null when absent or implausible. */
export function normalizeMessageId(value: string | null | undefined): string | null {
  if (!value) return null;
  const id = value.trim().replace(/^<+/, "").replace(/>+$/, "").trim();
  if (!id || id.length > 250 || /\s/.test(id)) return null;
  return id;
}

/** RFC 2919 List-Id: `"Phrase" <list.id>` → { id, phrase }. */
export function parseListId(value: string | null | undefined): { id: string; phrase: string | null } | null {
  if (!value) return null;
  const m = /<([^<>\s]+)>/.exec(value);
  const id = (m ? m[1] : value.trim()).toLowerCase();
  if (!id || id.length > 200 || /\s/.test(id)) return null;
  const phrase = m ? value.slice(0, m.index).trim().replace(/^"(.*)"$/, "$1").trim() : "";
  return { id, phrase: phrase || null };
}

export interface ListUnsubscribe {
  url: string | null;
  mailto: string | null;
  oneClick: boolean;
}

/** RFC 2369 List-Unsubscribe + RFC 8058 List-Unsubscribe-Post. Only https URLs are kept. */
export function parseListUnsubscribe(value: string | null | undefined, post: string | null | undefined): ListUnsubscribe {
  let url: string | null = null;
  let mailto: string | null = null;
  for (const m of (value ?? "").matchAll(/<([^<>]+)>/g)) {
    const candidate = m[1].trim().replace(/\s+/g, "");
    if (!url && /^https:\/\//i.test(candidate) && candidate.length <= 2000) {
      try {
        url = new URL(candidate).toString();
      } catch {
        // ignore malformed
      }
    } else if (!mailto && /^mailto:/i.test(candidate) && candidate.length <= 1000) {
      mailto = candidate;
    }
  }
  const oneClick = !!url && /List-Unsubscribe\s*=\s*One-Click/i.test(post ?? "");
  return { url, mailto, oneClick };
}

// ---------------------------------------------------------------------------
// Sender grouping

/** Platforms that send many different newsletters from one domain: group by full address. */
const SHARED_SENDER_DOMAINS = new Set([
  "substack.com", "beehiiv.com", "mail.beehiiv.com", "ghost.io", "buttondown.email", "buttondown.com",
  "convertkit.com", "convertkit-mail.com", "convertkit-mail2.com", "kit.com", "mailchimp.com", "mailchimpapp.net",
  "mailerlite.com", "sendinblue.com", "brevo.com", "revue.email", "gmail.com", "googlemail.com", "outlook.com",
  "hotmail.com", "yahoo.com", "icloud.com", "gmx.de", "gmx.net", "web.de", "medium.com", "linkedin.com",
]);
const SENDER_SUBDOMAIN_RE = /^(?:mail|email|e|news|newsletter|newsletters|info|hello|m|mg|send|updates|list|lists)\./;

export interface SenderIdentity {
  /** Grouping key, also the feed URL suffix: "list:<id>" | "domain:<host>" | "from:<address>". */
  key: string;
  title: string;
  domain: string | null;
  address: string | null;
}

export function senderIdentity(input: { listId: string | null; fromName: string | null; fromAddress: string | null }): SenderIdentity {
  const address = input.fromAddress?.toLowerCase() || null;
  const rawDomain = address && address.includes("@") ? address.slice(address.lastIndexOf("@") + 1) : null;
  const domain = rawDomain ? rawDomain.replace(SENDER_SUBDOMAIN_RE, "") : null;
  const list = parseListId(input.listId);
  const title = (list?.phrase || input.fromName || "").trim() || domain || address || "Newsletter";
  if (list) return { key: `list:${list.id}`, title, domain, address };
  if (domain && !SHARED_SENDER_DOMAINS.has(domain) && !SHARED_SENDER_DOMAINS.has(rawDomain!)) {
    return { key: `domain:${domain}`, title: input.fromName?.trim() || domain, domain, address };
  }
  return { key: `from:${address ?? "unknown"}`, title, domain, address };
}

// ---------------------------------------------------------------------------
// HTML hygiene

const TRACKING_PARAM_RE = /^(?:utm_[a-z_]+|mc_cid|mc_eid|_hsenc|_hsmi|__hssc|__hstc|__hsfp|hsctatracking|mkt_tok|ck_subscriber_id|vero_id|vero_conv|oly_enc_id|oly_anon_id|rb_clickid|s_cid|ml_subscriber|ml_subscriber_hash|ss_source|ss_campaign_id|ss_email_id|fbclid|gclid|msclkid|yclid|igshid|_bhlid|r_lang)$/i;

/** Drops known tracking query params from an http(s) URL; returns the input unchanged otherwise. */
export function stripTrackingParams(href: string): string {
  let url: URL;
  try {
    url = new URL(href);
  } catch {
    return href;
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") return href;
  let changed = false;
  for (const key of [...url.searchParams.keys()]) {
    if (TRACKING_PARAM_RE.test(key)) {
      url.searchParams.delete(key);
      changed = true;
    }
  }
  return changed ? url.toString() : href;
}

const TRACKER_IMAGE_HOST_RE = /(?:^|\.)(?:eotrx\.substackcdn\.com|open\.substack\.com|list-manage\.com|mailchimpapp\.net|open\.convertkit-mail\d*\.com|convertkit-mail\d*\.com|email\.mg\.[^/]+|sendgrid\.net|ct\.sendgrid\.net|track\.hubspot\.com|t\.hubspotemail\.net|mailtrack\.io|pixel\.mailerlite\.com|trk\.klclick\d*\.com|links\.mail\.beehiiv\.com|link\.mail\.beehiiv\.com|mandrillapp\.com|mcsv\.net|exct\.net|cmail\d+\.com|createsend\d*\.com)$/i;
const TRACKER_IMAGE_PATH_RE = /(?:^|\/)(?:track\/open(?:\.php)?|wf\/open|open\.(?:php|gif|png|aspx)|ss\/o|e\/o|o|open|pixel(?:\.gif|\.png)?|beacon|trk)(?:\/|$|\?)/i;

function isTinyDimension(value: string | null | undefined): boolean {
  if (value == null || value === "") return false;
  const n = parseFloat(value);
  return Number.isFinite(n) && n <= 1;
}

function styleValue(style: string, prop: string): string | null {
  const m = new RegExp(`(?:^|;)\\s*${prop}\\s*:\\s*([^;]+)`, "i").exec(style);
  return m ? m[1].trim().toLowerCase() : null;
}

/** 1×1 / invisible / known open-tracking images. */
export function isTrackingImage(img: { src: string; width?: string | null; height?: string | null; style?: string | null }): boolean {
  const style = img.style ?? "";
  if (isTinyDimension(img.width) || isTinyDimension(img.height)) return true;
  const sw = styleValue(style, "width");
  const sh = styleValue(style, "height");
  if ((sw && /^[\d.]+(?:px)?$/.test(sw) && isTinyDimension(sw)) || (sh && /^[\d.]+(?:px)?$/.test(sh) && isTinyDimension(sh))) return true;
  if (styleValue(style, "opacity") === "0" || styleValue(style, "visibility") === "hidden") return true;
  let url: URL;
  try {
    url = new URL(img.src);
  } catch {
    return false;
  }
  if (TRACKER_IMAGE_HOST_RE.test(url.hostname)) return true;
  return /(?:^|\.)(?:email|mail|click|track|trk|link|links|open|t)\./i.test(url.hostname) && TRACKER_IMAGE_PATH_RE.test(url.pathname);
}

const HIDDEN_STYLE_RE = /(?:^|;)\s*(?:display\s*:\s*none|visibility\s*:\s*hidden|mso-hide\s*:\s*all)/i;
const DROP_TAGS = "script, style, link, meta, title, head, template, noscript, form, input, button, textarea, select, iframe, frame, frameset, object, embed, svg, math, base";

interface InlineImage {
  contentId: string;
  mimeType: string;
  base64: string;
  bytes: number;
}

function inlineImageMap(email: ParsedEmail): Map<string, InlineImage> {
  const map = new Map<string, InlineImage>();
  for (const att of email.attachments) {
    const cid = att.contentId?.replace(/^<|>$/g, "").trim().toLowerCase();
    const mimeType = att.mimeType.toLowerCase();
    if (!cid || !INLINE_IMAGE_TYPES.has(mimeType) || typeof att.content !== "string") continue;
    const base64 = att.content.replace(/\s+/g, "");
    const bytes = Math.floor((base64.length * 3) / 4);
    map.set(cid, { contentId: cid, mimeType: mimeType === "image/jpg" ? "image/jpeg" : mimeType, base64, bytes });
  }
  return map;
}

/**
 * Pre-sanitize pass on the raw newsletter HTML (jsdom without scripts or
 * resource loading), then the shared DOMPurify pipeline. Returns safe HTML.
 */
export async function sanitizeNewsletterHtml(html: string, inlineImages: Map<string, InlineImage> = new Map()): Promise<string> {
  const dom = new JSDOM(html.slice(0, MAX_HTML_CHARS));
  const doc = dom.window.document;
  try {
    doc.querySelectorAll(DROP_TAGS).forEach((el) => el.remove());
    doc.querySelectorAll("[hidden], [style]").forEach((el) => {
      if (el.hasAttribute("hidden") || HIDDEN_STYLE_RE.test(el.getAttribute("style") ?? "")) el.remove();
    });

    let inlineBudget = MAX_INLINE_TOTAL_BYTES;
    doc.querySelectorAll("img").forEach((img) => {
      const src = (img.getAttribute("src") ?? "").trim();
      if (/^cid:/i.test(src)) {
        const image = inlineImages.get(decodeURIComponent(src.slice(4)).replace(/^<|>$/g, "").trim().toLowerCase());
        if (!image || image.bytes > MAX_INLINE_IMAGE_BYTES || image.bytes > inlineBudget) {
          img.remove();
          return;
        }
        inlineBudget -= image.bytes;
        img.setAttribute("src", `data:${image.mimeType};base64,${image.base64}`);
        img.removeAttribute("srcset");
        return;
      }
      // Only http(s) images from the mail itself; foreign data:/javascript: etc. go.
      if (!/^https?:\/\//i.test(src)) {
        img.remove();
        return;
      }
      if (isTrackingImage({ src, width: img.getAttribute("width"), height: img.getAttribute("height"), style: img.getAttribute("style") })) {
        img.remove();
      }
    });

    doc.querySelectorAll("a[href]").forEach((a) => {
      const href = a.getAttribute("href") ?? "";
      const cleaned = stripTrackingParams(href.trim());
      if (cleaned !== href) a.setAttribute("href", cleaned);
    });

    // Newsletter layout tables: drop fixed pixel widths/bgcolor attributes the
    // global sanitizer hook does not cover (it handles `width` + inline style).
    doc.querySelectorAll("[bgcolor], [background]").forEach((el) => {
      el.removeAttribute("bgcolor");
      el.removeAttribute("background");
    });

    const body = doc.body?.innerHTML ?? "";
    const DOMPurify = await getSanitizer();
    return DOMPurify.sanitize(body, { FORBID_TAGS: ["style", "form", "input", "button", "textarea", "select", "svg", "math"], FORBID_ATTR: ["srcset"] }).trim();
  } finally {
    dom.window.close();
  }
}

function escapeHtml(text: string): string {
  return text.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
}

/** Plain-text mails: paragraphs + linkified https URLs. */
export function textToHtml(text: string): string {
  return text
    .slice(0, MAX_TEXT_CHARS)
    .replace(/\r\n?/g, "\n")
    .split(/\n{2,}/)
    .map((para) => para.trim())
    .filter(Boolean)
    .map((para) => {
      const linked = escapeHtml(para).replace(/https?:\/\/[^\s<>"']+/g, (url) => {
        const clean = stripTrackingParams(url.replace(/&amp;/g, "&"));
        return `<a href="${escapeHtml(clean)}">${url}</a>`;
      });
      return `<p>${linked.replace(/\n/g, "<br>")}</p>`;
    })
    .join("\n");
}

// ---------------------------------------------------------------------------
// Double opt-in & "view in browser"

const CONFIRM_SUBJECT_RE = /\b(?:confirm|verify|activate|bestätig|bestaetig|verifizier|aktivier|double[\s-]?opt|opt[\s-]?in)/i;
const CONFIRM_BODY_RE = /(?:confirm (?:your|my) (?:subscription|email|e-mail)|verify your (?:email|e-mail|subscription)|bestätige (?:deine|dein|ihre|die)|bitte bestätigen|anmeldung bestätigen|abonnement bestätigen|activate your subscription)/i;
const CONFIRM_LINK_RE = /(?:confirm|verify|activate|bestätig|bestaetig|verifizier|aktivier|opt[-_]?in|double[-_]?opt)/i;
const UNSUBSCRIBE_RE = /(?:unsubscribe|abbestell|abmeld|opt[-_]?out|austragen)/i;
const VIEW_ONLINE_RE = /(?:view (?:it |this (?:email |post )?)?(?:in (?:your |a )?browser|online)|read (?:it |this )?online|web ?version|open in browser|im browser (?:ansehen|anzeigen|öffnen|lesen)|online (?:ansehen|lesen|anzeigen)|webversion)/i;

interface LinkInfo {
  href: string;
  text: string;
}

function collectLinks(html: string | undefined, text: string | undefined): LinkInfo[] {
  const links: LinkInfo[] = [];
  if (html) {
    const dom = new JSDOM(html.slice(0, MAX_HTML_CHARS));
    try {
      dom.window.document.querySelectorAll("a[href]").forEach((a) => {
        const href = (a.getAttribute("href") ?? "").trim();
        if (/^https:\/\//i.test(href)) links.push({ href, text: (a.textContent ?? "").replace(/\s+/g, " ").trim().slice(0, 200) });
      });
    } finally {
      dom.window.close();
    }
  } else if (text) {
    for (const m of text.slice(0, MAX_TEXT_CHARS).matchAll(/https:\/\/[^\s<>"']+/g)) links.push({ href: m[0], text: "" });
  }
  return links;
}

/** Spec §5.3: a confirmation link, or null. Stored for the user to click — never followed. */
export function detectConfirmationUrl(subject: string, bodyText: string, links: LinkInfo[]): string | null {
  if (!CONFIRM_SUBJECT_RE.test(subject) && !CONFIRM_BODY_RE.test(bodyText.slice(0, 20_000))) return null;
  const candidates = links.filter((l) => !UNSUBSCRIBE_RE.test(l.text) && !UNSUBSCRIBE_RE.test(l.href) && l.href.length <= 2000);
  const byText = candidates.find((l) => CONFIRM_LINK_RE.test(l.text));
  const byHref = candidates.find((l) => CONFIRM_LINK_RE.test(l.href));
  const pick = byText ?? byHref;
  if (!pick) return null;
  try {
    return new URL(pick.href).toString();
  } catch {
    return null;
  }
}

function detectViewOnlineUrl(links: LinkInfo[]): string | null {
  const hit = links.find((l) => VIEW_ONLINE_RE.test(l.text) && l.href.length <= 2000);
  if (!hit) return null;
  try {
    return new URL(stripTrackingParams(hit.href)).toString();
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Ingest

export type IngestStatus =
  | "created"
  | "duplicate"
  | "too-large"
  | "parse-error"
  | "no-token"
  | "unknown-token"
  | "inactive"
  | "rate-limited";

export interface IngestResult {
  status: IngestStatus;
  userId?: string;
  feedId?: string;
  articleId?: string;
  messageId?: string | null;
}

export interface IngestOptions {
  /** Envelope / delivery recipients (RCPT TO, Delivered-To, X-Original-To, …). */
  recipients: readonly string[];
  /** When the transport received the mail; default now. */
  receivedAt?: Date;
}

function rawSize(raw: Buffer | string): number {
  return typeof raw === "string" ? Buffer.byteLength(raw, "utf8") : raw.byteLength;
}

function publishedAtFor(dateHeader: string | undefined, receivedAt: Date): Date {
  const parsed = dateHeader ? new Date(dateHeader) : null;
  if (!parsed || Number.isNaN(parsed.getTime())) return receivedAt;
  // Future-dated or absurdly old senders: trust the receive time instead.
  if (parsed.getTime() > receivedAt.getTime() + 60 * 60_000) return receivedAt;
  if (parsed.getTime() < receivedAt.getTime() - 365 * 24 * 60 * 60_000) return receivedAt;
  return parsed;
}

async function ensureNewsletterCategory(userId: string): Promise<string> {
  const where = { userId, name: NEWSLETTER_CATEGORY_NAME, parentId: null };
  const existing = await db.category.findFirst({ where, select: { id: true } });
  if (existing) return existing.id;
  try {
    const order = await db.category.count({ where: { userId, parentId: null } });
    return (await db.category.create({ data: { userId, name: NEWSLETTER_CATEGORY_NAME, order }, select: { id: true } })).id;
  } catch (error) {
    const raced = await db.category.findFirst({ where, select: { id: true } });
    if (raced) return raced.id;
    throw error;
  }
}

type ResolvedFeed = { id: string; url: string; sourceType: string };
const FEED_SELECT = { id: true, url: true, sourceType: true } as const;

async function resolveFeed(userId: string, fixedFeedId: string | null, sender: SenderIdentity): Promise<ResolvedFeed> {
  if (fixedFeedId) {
    const fixed = await db.feed.findFirst({ where: { id: fixedFeedId, userId }, select: FEED_SELECT });
    if (fixed) return fixed;
  }
  const url = `${NEWSLETTER_FEED_URL_PREFIX}${sender.key}`;
  const existing = await db.feed.findUnique({ where: { userId_url: { userId, url } }, select: FEED_SELECT });
  if (existing) return existing;
  const categoryId = await ensureNewsletterCategory(userId);
  const order = await db.feed.count({ where: { userId } });
  try {
    return await db.feed.create({
      data: {
        userId,
        url,
        name: sender.title.slice(0, 200),
        sourceType: NEWSLETTER_SOURCE_TYPE,
        htmlUrl: sender.domain ? `https://${sender.domain}` : null,
        newsletterSender: sender.key,
        categoryId,
        order,
        lastStatus: "ok",
      },
      select: FEED_SELECT,
    });
  } catch (error) {
    const raced = await db.feed.findUnique({ where: { userId_url: { userId, url } }, select: FEED_SELECT });
    if (raced) return raced;
    throw error;
  }
}

/**
 * Ingest one raw email. Never throws for bad mail (returns a status); throws
 * only on infrastructure errors (DB down), so transports can retry.
 */
export async function ingestRawEmail(raw: Buffer | string, options: IngestOptions): Promise<IngestResult> {
  const receivedAt = options.receivedAt ?? new Date();
  if (rawSize(raw) > MAX_RAW_EMAIL_BYTES) {
    logger.warn("[inbound-email] rejected oversized mail", { bytes: rawSize(raw) });
    return { status: "too-large" };
  }

  // Envelope recipients first; header recipients only as a fallback for
  // transports that cannot see the envelope. The token itself is the secret.
  let tokens = extractRecipientTokens(options.recipients);

  let email: ParsedEmail;
  try {
    email = await PostalMime.parse(typeof raw === "string" ? raw : new Uint8Array(raw.buffer, raw.byteOffset, raw.byteLength), {
      attachmentEncoding: "base64",
      maxNestingDepth: 50,
      maxPartCount: 500,
    });
  } catch {
    logger.warn("[inbound-email] unparseable mail dropped");
    return { status: "parse-error" };
  }
  const messageId = normalizeMessageId(email.messageId ?? header(email, "message-id"));

  if (tokens.length === 0) {
    const headerRecipients = [
      ...headerAll(email, "delivered-to"),
      ...headerAll(email, "x-original-to"),
      ...headerAll(email, "envelope-to"),
      ...headerAll(email, "to"),
      ...headerAll(email, "cc"),
    ];
    tokens = extractRecipientTokens(headerRecipients);
  }
  if (tokens.length === 0) {
    logger.info("[inbound-email] no recipient token", { messageId });
    return { status: "no-token", messageId };
  }

  const addresses = await db.newsletterAddress.findMany({
    where: { token: { in: tokens.slice(0, 10) } },
    select: { id: true, userId: true, feedId: true, isActive: true, token: true },
  });
  const address = tokens.map((t) => addresses.find((a) => a.token === t && a.isActive)).find(Boolean);
  if (!address) {
    const status: IngestStatus = addresses.length > 0 ? "inactive" : "unknown-token";
    logger.info("[inbound-email] mail dropped", { status, messageId });
    return { status, messageId };
  }
  const userId = address.userId;

  const recent = await db.article.count({
    where: {
      userId,
      createdAt: { gte: new Date(receivedAt.getTime() - 24 * 60 * 60_000) },
      feed: { sourceType: NEWSLETTER_SOURCE_TYPE },
    },
  });
  if (recent >= MAX_NEWSLETTER_MAILS_PER_DAY) {
    logger.warn("[inbound-email] daily limit reached", { userId, messageId });
    return { status: "rate-limited", userId, messageId };
  }

  const from = mailbox(email.from);
  const sender = senderIdentity({ listId: header(email, "list-id"), fromName: from?.name ?? null, fromAddress: from?.address ?? null });
  const feed = await resolveFeed(userId, address.feedId, sender);

  const subject = (email.subject ?? "").replace(/\s+/g, " ").trim();
  const dedupeKey = messageId
    ? `email:${messageId}`
    : `email:sha256:${createHash("sha256").update([userId, feed.id, from?.address ?? "", subject, email.date ?? ""].join("\u0000")).digest("hex")}`;

  const existing = await db.article.findUnique({
    where: { userId_feedId_dedupeKey: { userId, feedId: feed.id, dedupeKey } },
    select: { id: true },
  });
  if (existing) {
    logger.info("[inbound-email] duplicate mail ignored", { userId, feedId: feed.id, messageId });
    return { status: "duplicate", userId, feedId: feed.id, articleId: existing.id, messageId };
  }

  const links = collectLinks(email.html, email.text);
  const content = email.html
    ? await sanitizeNewsletterHtml(email.html, inlineImageMap(email))
    : await sanitizeNewsletterHtml(textToHtml(email.text ?? ""));
  const plain = htmlToPlainText(content);
  const confirmationUrl = detectConfirmationUrl(subject, email.text ?? plain, links);
  const unsubscribe = parseListUnsubscribe(header(email, "list-unsubscribe"), header(email, "list-unsubscribe-post"));
  const viewOnline = detectViewOnlineUrl(links);
  const link = viewOnline ?? `${feed.url}#${encodeURIComponent(dedupeKey)}`;
  const title = (subject || sender.title).slice(0, 500);
  const publishedAt = publishedAtFor(email.date, receivedAt);
  const meta = computeArticleMeta({ content, contentFormat: "html", title, link });

  let articleId: string;
  try {
    const created = await db.article.create({
      data: {
        feedId: feed.id,
        userId,
        title,
        link,
        externalId: messageId,
        dedupeKey,
        contentHash: viewOnline ? computeContentHash(viewOnline) : null,
        content,
        contentFormat: "html",
        excerpt: plain.slice(0, 200),
        author: (from?.name || from?.address || null)?.slice(0, 200) ?? null,
        publishedAt,
        kind: meta.kind,
        readMinutes: meta.readMinutes,
        emailMessageId: messageId,
        emailSender: from?.address ?? null,
        confirmationUrl,
        listUnsubscribeUrl: unsubscribe.url,
        listUnsubscribeMailto: unsubscribe.mailto,
        listUnsubscribeOneClick: unsubscribe.url ? unsubscribe.oneClick : null,
      },
      select: { id: true },
    });
    articleId = created.id;
  } catch (error) {
    // Same Message-ID delivered twice concurrently (IMAP + webhook, retries).
    const raced = await db.article.findUnique({
      where: { userId_feedId_dedupeKey: { userId, feedId: feed.id, dedupeKey } },
      select: { id: true },
    });
    if (raced) return { status: "duplicate", userId, feedId: feed.id, articleId: raced.id, messageId };
    throw error;
  }

  await db.newsletterAddress.update({ where: { id: address.id }, data: { lastReceivedAt: receivedAt } });
  // A fixed target may be a normal web feed: never touch its sync bookkeeping.
  if (feed.sourceType === NEWSLETTER_SOURCE_TYPE) {
    await db.feed.update({ where: { id: feed.id }, data: { lastFetchedAt: receivedAt, lastStatus: "ok", lastError: null } });
  }

  logger.info("[inbound-email] newsletter stored", {
    userId,
    feedId: feed.id,
    articleId,
    messageId,
    attachmentsDropped: email.attachments.filter((a) => !a.contentId).length,
  });
  return { status: "created", userId, feedId: feed.id, articleId, messageId };
}
