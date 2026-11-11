"use server";

// N1 PR B: admin wizard for the newsletter inbox (spec §10). Admin-only.
// Credentials are sealed (ff2, purpose inboundMailSource.credentials) and
// never returned; the client sees `hasPassword` and sends "__keep__" (or "")
// to reuse the stored password.

import { db } from "@/lib/db";
import { logger } from "@/lib/logger";
import { requireAdmin, logAdminAction } from "@/lib/admin-auth";
import { pickFields } from "@/lib/pick-fields";
import { isMailServiceEnabled, sendSystemEmail } from "@/lib/mail";
import { addressString, ensurePrimaryNewsletterAddress } from "@/lib/newsletter-addresses";
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

export type WizardErrorCode = ImapErrorCode | "invalid-email" | "no-server" | "password-required" | "invalid-server" | "no-source";

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
  paused: true,
  lastReceivedAt: true,
  lastCheckedAt: true,
  errorCount: true,
  lastError: true,
  createdAt: true,
} as const;

function toView(row: SourceRow): InboundSourceView {
  const settings = parseImapSettings(row.settings);
  const code = storedErrorCode(row.lastError);
  return {
    id: row.id,
    kind: row.kind,
    address: row.address,
    server: settings ? { host: settings.host, port: settings.port, secure: settings.secure, presetId: settings.presetId, source: settings.presetId ? "preset" : "manual" } : null,
    preset: presetView(settings?.presetId),
    paused: row.paused,
    hasPassword: !!row.credentials,
    lastReceivedAt: row.lastReceivedAt?.toISOString() ?? null,
    lastCheckedAt: row.lastCheckedAt?.toISOString() ?? null,
    errorCount: row.errorCount,
    lastErrorCode: code,
    lastErrorDetail: row.lastError && code ? row.lastError.slice(code.length + 1).trim() || null : null,
    createdAt: row.createdAt.toISOString(),
  };
}

async function imapSourceRow(): Promise<SourceRow | null> {
  return db.inboundMailSource.findFirst({ where: { kind: "imap" }, orderBy: { createdAt: "asc" }, select: SOURCE_SELECT });
}

async function adminTestAddress(userId: string): Promise<string | null> {
  const source = await imapSourceRow();
  if (!source?.address) return null;
  const primary = await ensurePrimaryNewsletterAddress(userId);
  return addressString({ id: source.id, kind: source.kind, address: source.address, paused: source.paused }, primary.token);
}

// ---------------------------------------------------------------------------

export async function getNewsletterInboundState(): Promise<{ source: InboundSourceView | null; mailAvailable: boolean; testAddress: string | null }> {
  const session = await requireAdmin();
  const row = await imapSourceRow();
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

type ConnectInput = { email?: unknown; password?: unknown; host?: unknown; port?: unknown; secure?: unknown };
const CONNECT_FIELDS = ["email", "password", "host", "port", "secure"] as const;

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

  const existing = await imapSourceRow();
  const existingSettings = parseImapSettings(existing?.settings);
  let password = typeof data.password === "string" ? data.password : "";
  if (password === "" || password === KEEP) {
    // The stored password is reused only for the SAME mailbox on the SAME
    // server: it must never be sent to a host the admin just typed in.
    const sameTarget = existing?.address === mailbox && existingSettings?.host === server.host && existingSettings?.port === server.port;
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
  const result = await testImapConnection({ host: resolved.server.host, port: resolved.server.port, secure: resolved.server.secure, user: resolved.mailbox, pass: resolved.password });
  const preset = presetView(resolved.server.presetId);
  if (!result.ok) return { ok: false, code: result.code, detail: result.detail, server: resolved.server, preset };

  const data = {
    kind: "imap",
    name: preset?.label ?? resolved.server.host,
    address: resolved.mailbox,
    settings: JSON.stringify(resolved.settings),
    credentials: sealImapCredentials({ user: resolved.mailbox, pass: resolved.password }),
    paused: false,
    errorCount: 0,
    lastError: null,
    lastCheckedAt: null,
  };
  const row = resolved.existing
    ? await db.inboundMailSource.update({ where: { id: resolved.existing.id }, data, select: SOURCE_SELECT })
    : await db.inboundMailSource.create({ data, select: SOURCE_SELECT });
  await logAdminAction(session.user.id, "newsletter.inbound.save", { kind: "imap", host: resolved.server.host, presetId: resolved.server.presetId });
  return { ok: true, server: resolved.server, preset, folderCount: result.folders.length, processedFolderExists: result.processedFolderExists, source: toView(row) };
}

/** Step 3: send a test mail to the admin's own address via the instance mailer (if any). */
export async function sendNewsletterTestMail(): Promise<{ ok: true; address: string; sent: boolean; startedAt: string } | { ok: false; code: WizardErrorCode | "send-failed"; address?: string; startedAt?: string }> {
  const session = await requireAdmin();
  const address = await adminTestAddress(session.user.id);
  const startedAt = new Date(Date.now() - 1000).toISOString();
  if (!address) return { ok: false, code: "no-source" };
  if (!(await isMailServiceEnabled())) return { ok: true, address, sent: false, startedAt };
  try {
    await sendSystemEmail({
      to: address,
      subject: "FeedFerret – Testmail für den Newsletter-Eingang",
      text: "Wenn du diese Mail in FeedFerret im Ordner „Newsletter“ siehst, funktioniert der Newsletter-Eingang.\n\nIf you can read this in FeedFerret's \"Newsletter\" folder, the newsletter inbox works.",
      html: "<p>Wenn du diese Mail in FeedFerret im Ordner „Newsletter“ siehst, funktioniert der Newsletter-Eingang.</p><p>If you can read this in FeedFerret's “Newsletter” folder, the newsletter inbox works.</p>",
    });
    return { ok: true, address, sent: true, startedAt };
  } catch (error) {
    logger.warn("[newsletter-admin] test mail failed", { error: error instanceof Error ? error.name : "error" });
    return { ok: false, code: "send-failed", address, startedAt };
  }
}

/** Step 3 live status: polls the mailbox now (short forced gap) and reports arrival. */
export async function checkNewsletterTestMail(input: unknown): Promise<{ arrived: boolean; seconds: number | null; errorCode: string | null }> {
  const session = await requireAdmin();
  const { since } = pickFields((input ?? {}) as { since?: unknown }, ["since"]);
  const sinceDate = typeof since === "string" ? new Date(since) : null;
  if (!sinceDate || Number.isNaN(sinceDate.getTime())) return { arrived: false, seconds: null, errorCode: null };
  const source = await imapSourceRow();
  if (!source) return { arrived: false, seconds: null, errorCode: "no-source" };
  if (!source.paused) await pollInboundSourceNow(source.id).catch(() => null);
  const primary = await ensurePrimaryNewsletterAddress(session.user.id);
  const row = await db.newsletterAddress.findUnique({ where: { id: primary.id }, select: { lastReceivedAt: true } });
  const fresh = await imapSourceRow();
  const arrivedAt = row?.lastReceivedAt && row.lastReceivedAt.getTime() >= sinceDate.getTime() ? row.lastReceivedAt : null;
  return {
    arrived: !!arrivedAt,
    seconds: arrivedAt ? Math.max(0, Math.round((arrivedAt.getTime() - sinceDate.getTime()) / 1000)) : null,
    errorCode: storedErrorCode(fresh?.lastError),
  };
}

export async function setNewsletterInboundPaused(input: unknown): Promise<{ ok: boolean; source?: InboundSourceView }> {
  const session = await requireAdmin();
  const { paused } = pickFields((input ?? {}) as { paused?: unknown }, ["paused"]);
  if (typeof paused !== "boolean") return { ok: false };
  const existing = await imapSourceRow();
  if (!existing) return { ok: false };
  const row = await db.inboundMailSource.update({
    where: { id: existing.id },
    // Resuming starts fresh: no stale backoff from the paused period.
    data: paused ? { paused: true } : { paused: false, errorCount: 0, lastError: null, lastCheckedAt: null },
    select: SOURCE_SELECT,
  });
  await logAdminAction(session.user.id, paused ? "newsletter.inbound.pause" : "newsletter.inbound.resume");
  return { ok: true, source: toView(row) };
}

/** Removes the source (and its sealed credentials). User addresses stay, but receive nothing until a new source exists. */
export async function disconnectNewsletterInbound(): Promise<{ ok: boolean }> {
  const session = await requireAdmin();
  const existing = await imapSourceRow();
  if (!existing) return { ok: true };
  await db.inboundMailSource.delete({ where: { id: existing.id } });
  await logAdminAction(session.user.id, "newsletter.inbound.disconnect");
  return { ok: true };
}
