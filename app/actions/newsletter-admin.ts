"use server";

// N1 PR B/C: admin wizard for the newsletter inbox (spec §10). Admin-only.
// Credentials are sealed (ff2, purpose inboundMailSource.credentials) and
// never returned; the client sees `hasPassword` and sends "__keep__" (or "")
// to reuse the stored password. Webhook sources (Cloudflare / Postmark /
// Mailgun) keep a sealed HMAC secret (purpose inboundMailSource.webhookSecret)
// that is returned exactly once, by the action that creates it.
// One way in per instance: switching ways replaces the source.

import { randomBytes } from "node:crypto";
import { db } from "@/lib/db";
import { logger } from "@/lib/logger";
import { requireAdmin, logAdminAction } from "@/lib/admin-auth";
import { pickFields } from "@/lib/pick-fields";
import { isMailServiceEnabled, sendSystemEmail } from "@/lib/mail";
import { addressString, ensurePrimaryNewsletterAddress } from "@/lib/newsletter-addresses";
import {
  DISCONNECTED_KINDS,
  INBOUND_KINDS,
  isWebhookKind,
  sourceAddressesChange,
  webhookPathFor,
  WEBHOOK_KINDS,
  type WebhookKind,
} from "@/lib/newsletter-constants";
import { generateWebhookSecret, sealWebhookSecret } from "@/lib/inbound-email-webhook";
import { detectImapPreset, getImapPreset, isPlausibleMailbox, type PlusAddressing } from "@/lib/newsletter-imap-presets";
import {
  discoverImapServer,
  openImapCredentials,
  parseImapSettings,
  pollInboundSourceNow,
  PROCESSED_FOLDER,
  sealImapCredentials,
  storedErrorCode,
  testImapConnection,
  type ImapErrorCode,
  type ImapSourceSettings,
} from "@/lib/inbound-email-poller";

const KEEP = "__keep__";
const HOST_RE = /^(?=.{1,253}$)[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)*$|^\[?[0-9a-f:.]+\]?$/i;

export type WizardErrorCode =
  | ImapErrorCode
  | "invalid-email"
  | "no-server"
  | "password-required"
  | "invalid-server"
  | "no-source"
  | "confirm-address-change"
  | "invalid-domain"
  | "invalid-way"
  | "mail-unparseable"
  | "mail-too-large"
  | "payload-unsupported";

/** Subject marker of the end-to-end test mail ("FF-TEST-XXXXXX"). */
const TEST_MARKER_RE = /^FF-TEST-[A-Z2-7]{8}$/;
function newTestMarker(): string {
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
  return `FF-TEST-${Array.from(randomBytes(8), (b) => alphabet[b & 31]).join("")}`;
}

export interface PresetView {
  id: string;
  label: string;
  appPasswordUrl: string;
  plusAddressing: PlusAddressing;
  imapToggle: boolean;
  oauthOnlyRisk: boolean;
}

export interface ServerView {
  host: string;
  port: number;
  secure: boolean;
  presetId: string | null;
  source: "preset" | "srv" | "mx" | "guess" | "manual";
}

export interface InboundSourceView {
  id: string;
  kind: string;
  address: string | null;
  server: ServerView | null;
  preset: PresetView | null;
  paused: boolean;
  hasPassword: boolean;
  /** Webhook ways only: a secret is stored (never returned). */
  hasSecret: boolean;
  /** Webhook ways only: path of the endpoint; the browser prefixes its own origin. */
  webhookPath: string | null;
  lastReceivedAt: string | null;
  lastCheckedAt: string | null;
  errorCount: number;
  lastErrorCode: string | null;
  lastErrorDetail: string | null;
  createdAt: string;
}

function presetView(id: string | null | undefined): PresetView | null {
  const p = getImapPreset(id);
  return p
    ? { id: p.id, label: p.label, appPasswordUrl: p.appPasswordUrl, plusAddressing: p.plusAddressing, imapToggle: !!p.imapToggle, oauthOnlyRisk: !!p.oauthOnlyRisk }
    : null;
}

type SourceRow = {
  id: string;
  kind: string;
  address: string | null;
  settings: string | null;
  credentials: string | null;
  webhookSecret: string | null;
  paused: boolean;
  lastReceivedAt: Date | null;
  lastCheckedAt: Date | null;
  errorCount: number;
  lastError: string | null;
  createdAt: Date;
};

const SOURCE_SELECT = {
  id: true,
  kind: true,
  address: true,
  settings: true,
  credentials: true,
  webhookSecret: true,
  paused: true,
  lastReceivedAt: true,
  lastCheckedAt: true,
  errorCount: true,
  lastError: true,
  createdAt: true,
} as const;

function toView(row: SourceRow): InboundSourceView {
  const settings = row.kind === "imap" ? parseImapSettings(row.settings) : null;
  const code = storedErrorCode(row.lastError);
  return {
    id: row.id,
    kind: row.kind,
    address: row.address,
    server: settings ? { host: settings.host, port: settings.port, secure: settings.secure, presetId: settings.presetId, source: settings.presetId ? "preset" : "manual" } : null,
    preset: presetView(settings?.presetId),
    paused: row.paused,
    hasPassword: !!row.credentials,
    hasSecret: !!row.webhookSecret,
    webhookPath: isWebhookKind(row.kind) ? webhookPathFor(row.id) : null,
    lastReceivedAt: row.lastReceivedAt?.toISOString() ?? null,
    // While a poll runs, lastCheckedAt holds the end of its lease (future): show "now".
    lastCheckedAt: row.lastCheckedAt ? new Date(Math.min(row.lastCheckedAt.getTime(), Date.now())).toISOString() : null,
    errorCount: row.errorCount,
    lastErrorCode: code,
    lastErrorDetail: row.lastError && code ? row.lastError.slice(code.length + 1).trim() || null : null,
    createdAt: row.createdAt.toISOString(),
  };
}

async function lastDisconnectedRow(): Promise<{ kind: string; address: string | null } | null> {
  return db.inboundMailSource.findFirst({ where: { kind: { in: DISCONNECTED_KINDS } }, orderBy: { updatedAt: "desc" }, select: { kind: true, address: true } });
}

/** The instance's single way in (whatever kind), or null. */
async function primarySourceRow(): Promise<SourceRow | null> {
  return db.inboundMailSource.findFirst({ where: { kind: { in: [...INBOUND_KINDS] } }, orderBy: { createdAt: "asc" }, select: SOURCE_SELECT });
}

async function adminTestAddress(userId: string): Promise<string | null> {
  const source = await primarySourceRow();
  if (!source?.address) return null;
  const primary = await ensurePrimaryNewsletterAddress(userId);
  return addressString({ id: source.id, kind: source.kind, address: source.address, paused: source.paused }, primary.token);
}

// ---------------------------------------------------------------------------

export async function getNewsletterInboundState(): Promise<{ source: InboundSourceView | null; mailAvailable: boolean; testAddress: string | null }> {
  const session = await requireAdmin();
  const row = await primarySourceRow();
  return {
    source: row ? toView(row) : null,
    mailAvailable: await isMailServiceEnabled(),
    testAddress: row ? await adminTestAddress(session.user.id) : null,
  };
}

/** Step 2: what we detected for this address (preset / SRV / MX / imap.<domain>). */
export async function detectNewsletterImapServer(input: unknown): Promise<{ ok: true; server: ServerView; preset: PresetView | null } | { ok: false; code: WizardErrorCode }> {
  await requireAdmin();
  const { email } = pickFields((input ?? {}) as { email?: unknown }, ["email"]);
  const mailbox = typeof email === "string" ? email.trim().toLowerCase() : "";
  if (!isPlausibleMailbox(mailbox)) return { ok: false, code: "invalid-email" };
  const found = await discoverImapServer(mailbox).catch(() => null);
  if (!found) return { ok: false, code: "no-server" };
  return { ok: true, server: found, preset: presetView(found.presetId) };
}

type ConnectInput = { email?: unknown; password?: unknown; host?: unknown; port?: unknown; secure?: unknown; confirmAddressChange?: unknown };
const CONNECT_FIELDS = ["email", "password", "host", "port", "secure", "confirmAddressChange"] as const;

type Resolved =
  | { ok: true; mailbox: string; settings: ImapSourceSettings; server: ServerView; password: string; existing: SourceRow | null }
  | { ok: false; code: WizardErrorCode };

/** Validate the form, resolve the server and the password (incl. "__keep__"). */
async function resolveConnectInput(input: unknown): Promise<Resolved> {
  const data = pickFields((input ?? {}) as ConnectInput, CONNECT_FIELDS);
  const mailbox = typeof data.email === "string" ? data.email.trim().toLowerCase() : "";
  if (!isPlausibleMailbox(mailbox)) return { ok: false, code: "invalid-email" };

  let server: ServerView;
  const manualHost = typeof data.host === "string" ? data.host.trim().toLowerCase() : "";
  if (manualHost) {
    const port = Number(data.port ?? 993);
    if (!HOST_RE.test(manualHost) || !Number.isInteger(port) || port < 1 || port > 65535) return { ok: false, code: "invalid-server" };
    // A preset (app-password link, future authserv trust) only applies to the provider's own server.
    const preset = detectImapPreset(mailbox);
    server = { host: manualHost, port, secure: data.secure !== false, presetId: preset && preset.host === manualHost ? preset.id : null, source: "manual" };
  } else {
    const found = await discoverImapServer(mailbox).catch(() => null);
    if (!found) return { ok: false, code: "no-server" };
    server = found;
  }

  const existing = await primarySourceRow();
  const existingSettings = existing?.kind === "imap" ? parseImapSettings(existing.settings) : null;
  let password = typeof data.password === "string" ? data.password : "";
  if (password === "" || password === KEEP) {
    // The stored password is reused only for the SAME mailbox on the SAME
    // server: it must never be sent to a host the admin just typed in.
    const sameTarget = existing?.kind === "imap" && existing.address === mailbox && existingSettings?.host === server.host && existingSettings?.port === server.port;
    const stored = sameTarget ? openImapCredentials(existing?.credentials) : null;
    if (!stored) return { ok: false, code: "password-required" };
    password = stored.pass;
  }
  if (password.length > 1024) return { ok: false, code: "auth-failed" };

  return {
    ok: true,
    mailbox,
    server,
    password,
    existing,
    settings: {
      host: server.host,
      port: server.port,
      secure: server.secure,
      folder: existingSettings?.folder ?? "INBOX",
      presetId: server.presetId,
      processedFolder: existingSettings?.processedFolder ?? PROCESSED_FOLDER,
      // Learned by the poller about THIS server; kept while host + port stay.
      ...(existingSettings?.keywordsUnsupported && existingSettings.host === server.host && existingSettings.port === server.port ? { keywordsUnsupported: true } : {}),
    },
  };
}

export type TestResult =
  | { ok: true; server: ServerView; preset: PresetView | null; folderCount: number; processedFolderExists: boolean }
  | { ok: false; code: WizardErrorCode; detail?: string; server?: ServerView; preset?: PresetView | null };

/** Step 2 "Verbindung testen": login + folder list, < 10 s. Nothing is stored. */
export async function testNewsletterImap(input: unknown): Promise<TestResult> {
  await requireAdmin();
  const resolved = await resolveConnectInput(input);
  if (!resolved.ok) return resolved;
  const result = await testImapConnection({ host: resolved.server.host, port: resolved.server.port, secure: resolved.server.secure, user: resolved.mailbox, pass: resolved.password });
  const preset = presetView(resolved.server.presetId);
  if (!result.ok) return { ok: false, code: result.code, detail: result.detail, server: resolved.server, preset };
  return { ok: true, server: resolved.server, preset, folderCount: result.folders.length, processedFolderExists: result.processedFolderExists };
}

/** Step 2 "Speichern": tests again, then stores (one IMAP source per instance). */
export async function saveNewsletterImap(input: unknown): Promise<TestResult & { source?: InboundSourceView }> {
  const session = await requireAdmin();
  const resolved = await resolveConnectInput(input);
  if (!resolved.ok) return resolved;
  const preset = presetView(resolved.server.presetId);
  // Every user address derives from the base mailbox: a different mailbox (or
  // a new one after a disconnect while addresses exist) changes all of them.
  // Enforced here, not only in the UI.
  const { confirmAddressChange } = pickFields((input ?? {}) as ConnectInput, ["confirmAddressChange"]);
  // Only relevant when user addresses exist at all. After a disconnect the
  // last mailbox is remembered, so reconnecting the SAME one needs no confirm.
  const previous = resolved.existing ?? (await lastDisconnectedRow());
  const changesAddresses = sourceAddressesChange(previous, { kind: "imap", address: resolved.mailbox }) && (await db.newsletterAddress.count()) > 0;
  if (changesAddresses && confirmAddressChange !== true) {
    return { ok: false, code: "confirm-address-change", server: resolved.server, preset };
  }
  const result = await testImapConnection({ host: resolved.server.host, port: resolved.server.port, secure: resolved.server.secure, user: resolved.mailbox, pass: resolved.password });
  if (!result.ok) return { ok: false, code: result.code, detail: result.detail, server: resolved.server, preset };

  const data = {
    kind: "imap",
    name: preset?.label ?? resolved.server.host,
    address: resolved.mailbox,
    settings: JSON.stringify(resolved.settings),
    credentials: sealImapCredentials({ user: resolved.mailbox, pass: resolved.password }),
    // Switching from a webhook way: its secret goes away with it.
    webhookSecret: null,
    paused: false,
    errorCount: 0,
    lastError: null,
  };
  // lastCheckedAt is left alone on update: it may hold a running poll's lease.
  const row = resolved.existing
    ? await db.inboundMailSource.update({ where: { id: resolved.existing.id }, data, select: SOURCE_SELECT })
    : await db.inboundMailSource.create({ data, select: SOURCE_SELECT });
  // The remembered mailbox of an earlier disconnect is no longer needed.
  if (!resolved.existing) await db.inboundMailSource.deleteMany({ where: { kind: { in: DISCONNECTED_KINDS } } });
  await logAdminAction(session.user.id, "newsletter.inbound.save", { kind: "imap", host: resolved.server.host, presetId: resolved.server.presetId });
  return { ok: true, server: resolved.server, preset, folderCount: result.folders.length, processedFolderExists: result.processedFolderExists, source: toView(row) };
}

export type TestStart =
  | { ok: true; address: string; marker: string; sent: boolean; startedAt: string }
  | { ok: false; code: WizardErrorCode | "send-failed"; address?: string; marker?: string; startedAt?: string };

/**
 * Step 3: a unique subject marker for this test, plus — when the instance can
 * send mail and `send` is true — the test mail itself. Without a mailer the
 * admin sends one manually with the marker as subject.
 */
export async function startNewsletterTest(input: unknown): Promise<TestStart> {
  const session = await requireAdmin();
  const { send } = pickFields((input ?? {}) as { send?: unknown }, ["send"]);
  const address = await adminTestAddress(session.user.id);
  const startedAt = new Date(Date.now() - 1000).toISOString();
  if (!address) return { ok: false, code: "no-source" };
  const marker = newTestMarker();
  if (send !== true || !(await isMailServiceEnabled())) return { ok: true, address, marker, sent: false, startedAt };
  try {
    await sendSystemEmail({
      to: address,
      subject: `FeedFerret Testmail ${marker}`,
      text: "Wenn du diese Mail in FeedFerret im Ordner „Newsletter“ siehst, funktioniert der Newsletter-Eingang.\n\nIf you can read this in FeedFerret's \"Newsletter\" folder, the newsletter inbox works.",
      html: "<p>Wenn du diese Mail in FeedFerret im Ordner „Newsletter“ siehst, funktioniert der Newsletter-Eingang.</p><p>If you can read this in FeedFerret's “Newsletter” folder, the newsletter inbox works.</p>",
    });
    return { ok: true, address, marker, sent: true, startedAt };
  } catch (error) {
    logger.warn("[newsletter-admin] test mail failed", { error: error instanceof Error ? error.name : "error" });
    return { ok: false, code: "send-failed", address, marker, startedAt };
  }
}

/**
 * Step 3 live status: polls the mailbox now (short forced gap) and reports
 * whether an article whose title carries THIS test's marker arrived for the
 * admin — never "any mail since …".
 */
export async function checkNewsletterTestMail(input: unknown): Promise<{ arrived: boolean; seconds: number | null; errorCode: string | null }> {
  const session = await requireAdmin();
  const { since, marker } = pickFields((input ?? {}) as { since?: unknown; marker?: unknown }, ["since", "marker"]);
  const sinceDate = typeof since === "string" ? new Date(since) : null;
  if (!sinceDate || Number.isNaN(sinceDate.getTime()) || typeof marker !== "string" || !TEST_MARKER_RE.test(marker)) {
    return { arrived: false, seconds: null, errorCode: null };
  }
  const source = await primarySourceRow();
  if (!source) return { arrived: false, seconds: null, errorCode: "no-source" };
  // Webhook ways push; only a mailbox has to be polled.
  if (source.kind === "imap" && !source.paused) await pollInboundSourceNow(source.id).catch(() => null);
  const article = await db.article.findFirst({
    where: { userId: session.user.id, title: { contains: marker }, createdAt: { gte: new Date(sinceDate.getTime() - 15 * 60_000) } },
    orderBy: { createdAt: "asc" },
    select: { createdAt: true },
  });
  const fresh = await primarySourceRow();
  return {
    arrived: !!article,
    seconds: article ? Math.max(0, Math.round((article.createdAt.getTime() - sinceDate.getTime()) / 1000)) : null,
    errorCode: storedErrorCode(fresh?.lastError),
  };
}

export async function setNewsletterInboundPaused(input: unknown): Promise<{ ok: boolean; source?: InboundSourceView }> {
  const session = await requireAdmin();
  const { paused } = pickFields((input ?? {}) as { paused?: unknown }, ["paused"]);
  if (typeof paused !== "boolean") return { ok: false };
  const existing = await primarySourceRow();
  if (!existing) return { ok: false };
  const row = await db.inboundMailSource.update({
    where: { id: existing.id },
    // Resuming starts fresh: no stale backoff from the paused period.
    data: paused ? { paused: true } : { paused: false, errorCount: 0, lastError: null },
    select: SOURCE_SELECT,
  });
  await logAdminAction(session.user.id, paused ? "newsletter.inbound.pause" : "newsletter.inbound.resume");
  return { ok: true, source: toView(row) };
}

/**
 * Removes the source (and its sealed credentials). User addresses stay, but
 * receive nothing until a source exists again — and connecting a different
 * mailbox later changes all of them, so this needs `{ confirm: true }`.
 */
export async function disconnectNewsletterInbound(input?: unknown): Promise<{ ok: boolean; code?: "confirm-required" }> {
  const session = await requireAdmin();
  const { confirm } = pickFields((input ?? {}) as { confirm?: unknown }, ["confirm"]);
  if (confirm !== true) return { ok: false, code: "confirm-required" };
  const existing = await primarySourceRow();
  if (!existing) return { ok: true };
  // Credentials and secrets are wiped; only the base address is remembered
  // ("<kind>-disconnected") so reconnecting it keeps every user address.
  await db.inboundMailSource.deleteMany({ where: { kind: { in: DISCONNECTED_KINDS } } });
  await db.inboundMailSource.update({
    where: { id: existing.id },
    data: { kind: `${existing.kind}-disconnected`, credentials: null, webhookSecret: null, paused: true, errorCount: 0, lastError: null },
  });
  await logAdminAction(session.user.id, "newsletter.inbound.disconnect");
  return { ok: true };
}

// ---------------------------------------------------------------------------
// Webhook ways (Cloudflare Email Worker, Postmark / Mailgun / any relay)

const DOMAIN_RE = /^(?=.{4,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z][a-z0-9-]{0,61}[a-z0-9]$/;

/** "News.Example.com", "@news.example.com" → "news.example.com"; null when not a plain domain name. */
function normalizeNewsletterDomain(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const domain = value.trim().toLowerCase().replace(/^@/, "");
  return DOMAIN_RE.test(domain) ? domain : null;
}

export type DomainSaveResult =
  | { ok: true; /** Shown once: never returned again. */ secret: string; source: InboundSourceView }
  | { ok: false; code: WizardErrorCode };

/**
 * Step 2 for "cloudflare" / "webhook": stores the routed domain and a NEW
 * secret (also when the same way is set up again = rotation). The secret is in
 * this response only; afterwards the server keeps just the sealed value.
 */
export async function saveNewsletterDomainSource(input: unknown): Promise<DomainSaveResult> {
  const session = await requireAdmin();
  const data = pickFields((input ?? {}) as { kind?: unknown; domain?: unknown; confirmAddressChange?: unknown }, ["kind", "domain", "confirmAddressChange"]);
  const kind = (WEBHOOK_KINDS as readonly unknown[]).includes(data.kind) ? (data.kind as WebhookKind) : null;
  if (!kind) return { ok: false, code: "invalid-way" };
  const domain = normalizeNewsletterDomain(data.domain);
  if (!domain) return { ok: false, code: "invalid-domain" };

  const existing = await primarySourceRow();
  // User addresses derive from the base address: a different domain (or a switch
  // from mailbox plus-addressing) changes all of them. Enforced here, not only in the UI.
  const previous = existing ?? (await lastDisconnectedRow());
  if (sourceAddressesChange(previous, { kind, address: domain }) && (await db.newsletterAddress.count()) > 0 && data.confirmAddressChange !== true) {
    return { ok: false, code: "confirm-address-change" };
  }

  const secret = generateWebhookSecret();
  const fields = {
    kind,
    name: kind === "cloudflare" ? "Cloudflare Email Routing" : "Webhook",
    address: domain,
    settings: null,
    credentials: null,
    webhookSecret: sealWebhookSecret(secret),
    // Rotating the secret of a paused source must not quietly resume it.
    paused: existing?.kind === kind ? existing.paused : false,
    errorCount: 0,
    lastError: null,
  };
  const row = existing
    ? await db.inboundMailSource.update({ where: { id: existing.id }, data: fields, select: SOURCE_SELECT })
    : await db.inboundMailSource.create({ data: fields, select: SOURCE_SELECT });
  if (!existing) await db.inboundMailSource.deleteMany({ where: { kind: { in: DISCONNECTED_KINDS } } });
  await logAdminAction(session.user.id, "newsletter.inbound.save", { kind, domain });
  return { ok: true, secret, source: toView(row) };
}
