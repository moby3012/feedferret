// N1 PR B: IMAP transport for the newsletter inbox (spec §10).
//
// One shared mailbox (admin-configured InboundMailSource kind "imap") receives
// `box+ff-<token>@provider` mail for every user. The poller only touches
// messages whose delivery recipients carry a well-formed `+ff-<token>` for
// THAT mailbox; everything else in the folder stays untouched. Processed
// messages move to the IMAP folder "FeedFerret" (fallback: \Seen + \Flagged +
// $FeedFerret keyword).
//
// Network policy: the IMAP socket follows the same rules as lib/ssrf — the
// host is resolved once, every answer must be public (unless the admin's
// "allow internal feed URLs" switch / TRUSTED_FEED_FETCHING is on), and the
// socket connects to that pinned IP with SNI/cert check on the hostname, so a
// DNS rebind between check and connect cannot reach an internal address.
import dns from "node:dns/promises";
import net from "node:net";
import { ImapFlow, type ImapFlowOptions } from "imapflow";
import { db } from "@/lib/db";
import { logger } from "@/lib/logger";
import { isPrivateIp } from "@/lib/private-ip";
import { isTrustedFeedFetchingAllowed } from "@/lib/ssrf";
import { readPlainColumnState, sealSecret } from "@/lib/secret-box";
import { ingestRawEmail, isNewsletterToken, MAX_NEWSLETTER_MAILS_PER_DAY, MAX_RAW_EMAIL_BYTES, quotaDay, type IngestResult } from "@/lib/inbound-email";
import { afterIngest } from "@/lib/newsletter-after-ingest";
import { detectImapPreset, emailDomain, getImapPreset, trustedAuthservIdForPreset, type ImapPreset } from "@/lib/newsletter-imap-presets";
import { isAddressRun, matchAddressRuns } from "@/lib/linear-text";

export const CREDENTIALS_PURPOSE = "inboundMailSource.credentials";
export const PROCESSED_FOLDER = "FeedFerret";
export const PROCESSED_KEYWORD = "$FeedFerret";
/**
 * A disconnected IMAP source keeps its row (without credentials) under this
 * kind, only to remember the last base mailbox: reconnecting the SAME mailbox
 * keeps every user address and needs no confirmation. Nothing polls it.
 */
export const DISCONNECTED_IMAP_KIND = "imap-disconnected";

/** Connect + greeting + TLS budget per attempt. */
export const CONNECT_TIMEOUT_MS = 10_000;
/** Socket inactivity per command. */
export const COMMAND_TIMEOUT_MS = 30_000;
/** Whole "Verbindung testen" round trip (spec: < 10 s answer to the admin). */
export const TEST_TOTAL_TIMEOUT_MS = 10_000;
/** Whole poll (stays below the background job timeout of 90 s). */
export const POLL_TOTAL_TIMEOUT_MS = 60_000;
/** Messages processed (downloaded + ingested) per poll; the rest waits for the next one. */
export const MAX_MESSAGES_PER_POLL = 50;
/** Per address (token) and poll: one busy newsletter address cannot fill the whole poll. */
export const MAX_MESSAGES_PER_TOKEN_PER_POLL = 20;
/** After the total deadline the running poll may still finish the current mail and mark what it did. */
const POLL_GRACE_MS = 10_000;
/** Only look at this many recent UIDs / days in the folder. */
const SCAN_UID_LIMIT = 300;
const SCAN_DAYS = 14;
/** Regular poll cadence (the timer in background-sync ticks at this pace). */
export const POLL_INTERVAL_MS = 2 * 60_000;
/** Minimum gap for a forced poll (wizard live test). */
export const FORCED_POLL_GAP_MS = 8_000;
const MAX_BACKOFF_MS = 60 * 60_000;

// ---------------------------------------------------------------------------
// Settings / credentials

export interface ImapSourceSettings {
  host: string;
  port: number;
  /** true: implicit TLS; false: STARTTLS is REQUIRED (doSTARTTLS) — never cleartext. */
  secure: boolean;
  folder: string;
  presetId: string | null;
  processedFolder: string;
  /**
   * The server refused the `$FeedFerret` keyword (no `\*` in PERMANENTFLAGS)
   * once; only then does plain `\Seen` + `\Flagged` count as "processed".
   */
  keywordsUnsupported?: boolean;
}

export interface ImapCredentials {
  user: string;
  pass: string;
}

export function parseImapSettings(raw: string | null | undefined): ImapSourceSettings | null {
  if (!raw) return null;
  try {
    const value = JSON.parse(raw) as Partial<ImapSourceSettings>;
    if (typeof value.host !== "string" || !value.host) return null;
    const port = Number(value.port);
    return {
      host: value.host,
      port: Number.isInteger(port) && port > 0 && port < 65536 ? port : 993,
      secure: value.secure !== false,
      folder: typeof value.folder === "string" && value.folder ? value.folder : "INBOX",
      presetId: typeof value.presetId === "string" ? value.presetId : null,
      processedFolder: typeof value.processedFolder === "string" && value.processedFolder ? value.processedFolder : PROCESSED_FOLDER,
      keywordsUnsupported: value.keywordsUnsupported === true,
    };
  } catch {
    return null;
  }
}

export function sealImapCredentials(credentials: ImapCredentials): string {
  return sealSecret(CREDENTIALS_PURPOSE, JSON.stringify({ user: credentials.user, pass: credentials.pass }));
}

/** Opened credentials, or null when absent/unreadable (wrong key: logged once, never the value). */
export function openImapCredentials(stored: string | null | undefined): ImapCredentials | null {
  const { value } = readPlainColumnState(CREDENTIALS_PURPOSE, stored);
  if (!value) return null;
  try {
    const parsed = JSON.parse(value) as Partial<ImapCredentials>;
    if (typeof parsed.user !== "string" || typeof parsed.pass !== "string") return null;
    return { user: parsed.user, pass: parsed.pass };
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Errors (stable codes the wizard maps to German copy)

export type ImapErrorCode =
  | "auth-failed"
  | "app-password-required"
  | "imap-disabled"
  | "tls"
  | "timeout"
  | "host-blocked"
  | "host-not-found"
  | "unreachable"
  | "folder"
  | "credentials-unreadable"
  | "unknown";

export class ImapPollError extends Error {
  constructor(public readonly code: ImapErrorCode, message: string) {
    super(message);
    this.name = "ImapPollError";
  }
}

const APP_PASSWORD_RE = /application-specific password|app(?:lication)?[- ]?passwor|anwendungsspezifisch|webloginrequired|\bweb login required\b/i;
const IMAP_DISABLED_RE = /not enabled for imap|imap (?:access )?(?:is )?disabled|imap.*(?:nicht aktiviert|deaktiviert)|enable imap|imap use/i;

export function classifyImapError(error: unknown): ImapErrorCode {
  if (error instanceof ImapPollError) return error.code;
  const e = (error ?? {}) as Record<string, unknown>;
  const code = String(e.code ?? "");
  // Capped: server-provided text, and `imap.*(?:…)` below backtracks super-linearly on "imapimapimap…".
  const text = [e.responseText, e.message, e.serverResponseCode].filter((v) => typeof v === "string").join(" ").slice(0, 2_000);
  if (code === "ERR_SSRF_PRIVATE_IP") return "host-blocked";
  if (IMAP_DISABLED_RE.test(text)) return "imap-disabled";
  if (APP_PASSWORD_RE.test(text)) return "app-password-required";
  if (e.authenticationFailed || /AUTHENTICATIONFAILED|AUTHORIZATIONFAILED|invalid credentials|login failed|authentication failed/i.test(text)) return "auth-failed";
  if (e.tlsFailed || /^ERR_TLS|^ERR_SSL|CERT|SELF_SIGNED|UNABLE_TO_VERIFY/i.test(code) || /certificate|ssl routines|tls/i.test(text)) return "tls";
  if (/TIMEOUT|ETIMEDOUT/i.test(code) || /timed? ?out/i.test(text)) return "timeout";
  if (code === "ENOTFOUND" || code === "EAI_AGAIN" || code === "ENODATA") return "host-not-found";
  if (["ECONNREFUSED", "ECONNRESET", "EHOSTUNREACH", "ENETUNREACH", "NoConnection", "EConnectionClosed", "ClosedAfterConnectTLS", "ClosedAfterConnectText"].includes(code)) return "unreachable";
  return "unknown";
}

// `+ff-<token>` plain or URL-encoded (`%2Bff-…`). Residual risk (accepted):
// only this shape is redacted; a token quoted some other way in a server
// error would survive — server texts never contain recipient addresses in
// practice, and lastError is admin-only.
const TOKEN_LIKE_RE = /(?:\+|%2B)ff-[a-z2-7]{6,}/gi;

/**
 * Error text that is safe to store in `InboundMailSource.lastError` and show
 * in the admin panel: no password, user name, addresses or `+ff-` tokens.
 */
export function redactImapError(text: string, secrets: readonly (string | null | undefined)[] = []): string {
  let out = String(text ?? "");
  for (const secret of secrets) {
    if (secret && secret.length >= 3) out = out.split(secret).join("[redacted]");
  }
  return out.replace(TOKEN_LIKE_RE, "+ff-[token]").replace(/[^\s<>"'(),;:]+/g, (run) => (isAddressRun(run) ? "[address]" : run)).replace(/\s+/g, " ").trim().slice(0, 300);
}

export function formatStoredError(code: ImapErrorCode, detail: string): string {
  return detail ? `${code}: ${detail}`.slice(0, 400) : code;
}

/** Code of a stored `lastError` ("auth-failed: …" → "auth-failed"). */
export function storedErrorCode(lastError: string | null | undefined): ImapErrorCode | null {
  if (!lastError) return null;
  const code = lastError.split(":")[0].trim();
  return (code || "unknown") as ImapErrorCode;
}

// ---------------------------------------------------------------------------
// Host policy (DNS pinning, SSRF rules)

export type LookupFn = (hostname: string) => Promise<{ address: string; family: number }[]>;
const defaultLookup: LookupFn = (hostname) => dns.lookup(hostname, { all: true, verbatim: false });

const HOSTNAME_RE = /^(?=.{1,253}$)[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)*$/i;

export interface PinnedHost {
  /** What the socket connects to: the validated IP. */
  address: string;
  /** Hostname for SNI + certificate check (undefined for an IP literal). */
  servername: string | undefined;
}

/**
 * Resolve once and validate EVERY answer; connect to the first. Private,
 * loopback, link-local and metadata addresses are refused unless internal
 * targets are allowed by the instance policy.
 */
export async function pinImapHost(rawHost: string, options: { allowInternal: boolean; lookup?: LookupFn }): Promise<PinnedHost> {
  const host = rawHost.trim().toLowerCase().replace(/^\[|\]$/g, "").replace(/\.$/, "");
  if (net.isIP(host)) {
    if (!options.allowInternal && isPrivateIp(host)) throw new ImapPollError("host-blocked", "IMAP host is a private IP");
    return { address: host, servername: undefined };
  }
  if (!HOSTNAME_RE.test(host)) throw new ImapPollError("host-not-found", "IMAP host name is invalid");
  if (!options.allowInternal && (host === "localhost" || host.endsWith(".localhost") || host.endsWith(".internal") || host.endsWith(".local"))) {
    throw new ImapPollError("host-blocked", "IMAP host points to the local network");
  }
  let answers: { address: string; family: number }[];
  try {
    answers = await (options.lookup ?? defaultLookup)(host);
  } catch (error) {
    throw new ImapPollError("host-not-found", `DNS lookup failed (${(error as { code?: string })?.code ?? "error"})`);
  }
  if (answers.length === 0) throw new ImapPollError("host-not-found", "IMAP host has no address");
  if (!options.allowInternal && answers.some((a) => isPrivateIp(a.address))) {
    throw new ImapPollError("host-blocked", "IMAP host resolves to a private IP");
  }
  return { address: answers[0].address, servername: host };
}

// ---------------------------------------------------------------------------
// Autodiscovery

export interface DiscoveredServer {
  host: string;
  port: number;
  secure: boolean;
  presetId: string | null;
  source: "preset" | "srv" | "mx" | "guess";
}

export interface DiscoveryDeps {
  resolveSrv?: (name: string) => Promise<{ name: string; port: number; priority: number; weight: number }[]>;
  resolveMx?: (name: string) => Promise<{ exchange: string; priority: number }[]>;
  lookup?: LookupFn;
}

const MX_PRESETS: readonly [RegExp, string][] = [
  [/(?:^|\.)(?:google|googlemail)\.com$/, "gmail"],
  [/\.mail\.protection\.outlook\.com$/, "outlook"],
  [/(?:^|\.)messagingengine\.com$/, "fastmail"],
  [/(?:^|\.)mail\.icloud\.com$/, "icloud"],
  [/(?:^|\.)mailbox\.org$/, "mailboxorg"],
  [/(?:^|\.)posteo\.de$/, "posteo"],
];

function presetServer(preset: ImapPreset, source: DiscoveredServer["source"]): DiscoveredServer {
  return { host: preset.host, port: preset.port, secure: preset.secure, presetId: preset.id, source };
}

/**
 * Server for a mailbox address: known provider preset → DNS SRV
 * `_imaps._tcp` (RFC 6186) → MX of a known provider (custom domains on
 * Google Workspace, Microsoft 365, Fastmail …) → `imap.<domain>` if it
 * resolves. Null when nothing fits (the admin then uses "Erweitert").
 */
export async function discoverImapServer(email: string, deps: DiscoveryDeps = {}): Promise<DiscoveredServer | null> {
  const preset = detectImapPreset(email);
  if (preset) return presetServer(preset, "preset");
  const domain = emailDomain(email);
  if (!domain) return null;
  const resolveSrv = deps.resolveSrv ?? ((name: string) => dns.resolveSrv(name));
  const resolveMx = deps.resolveMx ?? ((name: string) => dns.resolveMx(name));
  const lookup = deps.lookup ?? defaultLookup;

  const srv = await resolveSrv(`_imaps._tcp.${domain}`).catch(() => []);
  const best = srv.filter((r) => r.name && r.name !== "." && r.port > 0).sort((a, b) => a.priority - b.priority || b.weight - a.weight)[0];
  if (best) return { host: best.name.replace(/\.$/, "").toLowerCase(), port: best.port, secure: true, presetId: null, source: "srv" };

  const mx = await resolveMx(domain).catch(() => []);
  for (const record of mx.sort((a, b) => a.priority - b.priority)) {
    const exchange = record.exchange.replace(/\.$/, "").toLowerCase();
    const hit = MX_PRESETS.find(([re]) => re.test(exchange));
    const mxPreset = hit ? getImapPreset(hit[1]) : null;
    if (mxPreset) return presetServer(mxPreset, "mx");
  }

  const guess = `imap.${domain}`;
  const answers = await lookup(guess).catch(() => []);
  if (answers.length > 0) return { host: guess, port: 993, secure: true, presetId: null, source: "guess" };
  return null;
}

// ---------------------------------------------------------------------------
// Recipient filtering

const RECIPIENT_HEADERS = ["delivered-to", "x-original-to", "envelope-to", "x-delivered-to", "x-forwarded-to", "to", "cc"] as const;

/** Unfolded `name: value` pairs of a raw header block (keys lowercase). */
export function parseHeaderBlock(raw: Buffer | string | undefined | null): { key: string; value: string }[] {
  if (!raw) return [];
  const text = (typeof raw === "string" ? raw : raw.toString("utf8")).split(/\r?\n\r?\n/)[0];
  const out: { key: string; value: string }[] = [];
  for (const line of text.split(/\r?\n/)) {
    if (/^[ \t]/.test(line) && out.length > 0) {
      out[out.length - 1].value += ` ${line.trim()}`;
      continue;
    }
    const colon = line.indexOf(":");
    if (colon <= 0) continue;
    out.push({ key: line.slice(0, colon).trim().toLowerCase(), value: line.slice(colon + 1).trim() });
  }
  return out;
}

export function recipientHeaderValues(raw: Buffer | string | undefined | null): string[] {
  return parseHeaderBlock(raw)
    .filter((h) => (RECIPIENT_HEADERS as readonly string[]).includes(h.key))
    .map((h) => h.value);
}


function canonicalLocal(local: string, preset: ImapPreset | null): string {
  return preset?.ignoreLocalDots ? local.replace(/\./g, "") : local;
}

/**
 * Recipient addresses in `values` that are `<mailbox local>+ff-<token>@<mailbox
 * domain>` (domain aliases of the preset allowed, Gmail dots ignored). Returns
 * the matching addresses and their tokens; anything else is not ours.
 */
export function mailboxRecipients(values: readonly string[], mailbox: string, presetId?: string | null): { addresses: string[]; tokens: string[] } {
  const base = mailbox.trim().toLowerCase();
  const at = base.lastIndexOf("@");
  if (at <= 0) return { addresses: [], tokens: [] };
  const preset = getImapPreset(presetId) ?? detectImapPreset(base);
  const baseLocal = canonicalLocal(base.slice(0, at).split("+")[0], preset);
  const baseDomain = base.slice(at + 1);
  const domains = new Set([baseDomain, ...(preset?.domains.includes(baseDomain) ? preset.domains : [])]);
  const addresses: string[] = [];
  const tokens: string[] = [];
  for (const value of values) {
    for (const address of matchAddressRuns(String(value).toLowerCase())) {
      const i = address.lastIndexOf("@");
      const domain = address.slice(i + 1);
      const local = address.slice(0, i);
      const plus = local.indexOf("+");
      if (plus <= 0 || !domains.has(domain)) continue;
      if (canonicalLocal(local.slice(0, plus), preset) !== baseLocal) continue;
      const tag = local.slice(plus + 1);
      if (!tag.startsWith("ff-")) continue;
      const token = tag.slice(3);
      if (!isNewsletterToken(token)) continue;
      if (!addresses.includes(address)) addresses.push(address);
      if (!tokens.includes(token)) tokens.push(token);
    }
  }
  return { addresses, tokens };
}

// ---------------------------------------------------------------------------
// IMAP client boundary (injectable for tests)

/** The subset of ImapFlow the poller uses. */
export interface ImapClientLike {
  /** Selected mailbox (imapflow); `permanentFlags` tells whether custom keywords are allowed. */
  mailbox?: { permanentFlags?: Set<string> } | false;
  connect(): Promise<void>;
  list(): Promise<{ path: string; specialUse?: string }[]>;
  getMailboxLock(path: string): Promise<{ release(): void }>;
  search(query: Record<string, unknown>, options: { uid: true }): Promise<number[] | false>;
  fetch(range: number[] | string, query: Record<string, unknown>, options: { uid: true }): AsyncIterable<{ uid: number; flags?: Set<string>; size?: number; headers?: Buffer }>;
  fetchOne(range: string, query: Record<string, unknown>, options: { uid: true }): Promise<{ uid: number; source?: Buffer } | false>;
  mailboxCreate(path: string): Promise<unknown>;
  messageMove(range: number[] | string, destination: string, options: { uid: true }): Promise<unknown>;
  messageFlagsAdd(range: number[] | string, flags: string[], options: { uid: true }): Promise<unknown>;
  logout(): Promise<void>;
  close(): void;
}

export type ImapClientFactory = (options: ImapFlowOptions) => ImapClientLike;
const defaultFactory: ImapClientFactory = (options) => new ImapFlow(options) as unknown as ImapClientLike;

export interface ConnectTarget {
  host: string;
  port: number;
  secure: boolean;
  user: string;
  pass: string;
}

export interface ImapDeps {
  clientFactory?: ImapClientFactory;
  lookup?: LookupFn;
  allowInternal?: boolean;
  now?: () => Date;
}

/** e2e harness only (see lib/inbound-email-fake-imap.ts); null everywhere else. */
async function fakeDeps(): Promise<{ clientFactory: ImapClientFactory; lookup: LookupFn } | null> {
  if (process.env.FEEDFERRET_FAKE_IMAP !== "1") return null;
  const fake = await import("./inbound-email-fake-imap");
  return fake.isFakeImapEnabled() ? fake.fakeImapDeps() : null;
}

async function connectClient(target: ConnectTarget, deps: ImapDeps): Promise<ImapClientLike> {
  const fake = deps.clientFactory ? null : await fakeDeps();
  const allowInternal = deps.allowInternal ?? (await isTrustedFeedFetchingAllowed());
  const pinned = await pinImapHost(target.host, { allowInternal, lookup: fake?.lookup ?? deps.lookup });
  const client = (fake?.clientFactory ?? deps.clientFactory ?? defaultFactory)({
    host: pinned.address,
    servername: pinned.servername,
    port: target.port,
    secure: target.secure,
    // Credentials never cross the wire in cleartext: no STARTTLS → no login.
    doSTARTTLS: target.secure ? undefined : true,
    auth: { user: target.user, pass: target.pass },
    logger: false,
    disableAutoIdle: true,
    disableCompression: true,
    connectionTimeout: CONNECT_TIMEOUT_MS,
    greetingTimeout: CONNECT_TIMEOUT_MS,
    socketTimeout: COMMAND_TIMEOUT_MS,
    maxLiteralSize: MAX_RAW_EMAIL_BYTES + 1024 * 1024,
    maxResponseSize: MAX_RAW_EMAIL_BYTES + 4 * 1024 * 1024,
    clientInfo: { name: "FeedFerret" },
    tls: { servername: pinned.servername, rejectUnauthorized: true, minVersion: "TLSv1.2" },
  });
  await client.connect();
  return client;
}

/** Race `work` against a deadline; on expiry the client is torn down. */
async function withDeadline<T>(ms: number, client: () => ImapClientLike | null, work: Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      try {
        client()?.close();
      } catch {
        /* already closed */
      }
      reject(new ImapPollError("timeout", `IMAP did not finish within ${Math.round(ms / 1000)} s`));
    }, ms);
    timer.unref?.();
  });
  try {
    return await Promise.race([work, deadline]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

async function closeQuietly(client: ImapClientLike | null) {
  if (!client) return;
  try {
    await Promise.race([client.logout(), new Promise((resolve) => setTimeout(resolve, 2_000).unref?.())]);
  } catch {
    /* ignore */
  }
  try {
    client.close();
  } catch {
    /* ignore */
  }
}

// ---------------------------------------------------------------------------
// "Verbindung testen"

export type ImapTestResult =
  | { ok: true; folders: string[]; processedFolderExists: boolean }
  | { ok: false; code: ImapErrorCode; detail: string };

export async function testImapConnection(target: ConnectTarget, deps: ImapDeps = {}): Promise<ImapTestResult> {
  let client: ImapClientLike | null = null;
  try {
    return await withDeadline(
      TEST_TOTAL_TIMEOUT_MS,
      () => client,
      (async () => {
        client = await connectClient(target, deps);
        const folders = (await client.list()).map((f) => f.path).slice(0, 200);
        return { ok: true as const, folders, processedFolderExists: folders.some((f) => f.toLowerCase() === PROCESSED_FOLDER.toLowerCase()) };
      })(),
    );
  } catch (error) {
    const code = classifyImapError(error);
    const detail = redactImapError(String((error as { responseText?: string })?.responseText || (error as Error)?.message || ""), [target.pass, target.user]);
    return { ok: false, code, detail };
  } finally {
    await closeQuietly(client);
  }
}

// ---------------------------------------------------------------------------
// Poll

export interface PollSummary {
  sourceId: string;
  status: "ok" | "skipped" | "error" | "paused";
  scanned: number;
  matched: number;
  created: number;
  moved: number;
  /** Matching mail left for later: owner over the daily quota, per-poll / per-address caps. */
  deferred: number;
  /** `+ff-` mail with no active address behind it: marked processed without download. */
  junk: number;
  /** Unprocessed mail outside the scan window (newest SCAN_UID_LIMIT UIDs). */
  outOfWindow: number;
  /** The total deadline hit; what was done until then is kept. */
  partial?: boolean;
  errorCode?: ImapErrorCode;
}

type SourceRow = {
  id: string;
  kind: string;
  address: string | null;
  settings: string | null;
  credentials: string | null;
  paused: boolean;
  errorCount: number;
  lastCheckedAt: Date | null;
};

const SOURCE_SELECT = { id: true, kind: true, address: true, settings: true, credentials: true, paused: true, errorCount: true, lastCheckedAt: true } as const;

/** Wait before the next regular poll: the interval, or exponential backoff after errors (2,4,8… min, max 60). */
export function pollGapMs(errorCount: number): number {
  if (errorCount <= 0) return POLL_INTERVAL_MS - 5_000;
  return Math.min(MAX_BACKOFF_MS, 60_000 * 2 ** Math.min(errorCount, 10));
}

/** How long a claim holds the source: the whole poll incl. grace, so no second poll can start meanwhile. */
export const POLL_LEASE_MS = POLL_TOTAL_TIMEOUT_MS + POLL_GRACE_MS + 5_000;

/**
 * Cross-process lock + schedule in one conditional UPDATE. A claim moves
 * `lastCheckedAt` to the END of the lease (in the future), so while a poll
 * runs `lastCheckedAt < now - gap` is false for every other caller — a
 * forced live-test poll included. When the poll finishes, `lastCheckedAt` is
 * set to the real finish time; a crashed poll frees the source when its
 * lease runs out.
 */
async function claimSource(source: SourceRow, force: boolean, now: Date): Promise<Date | null> {
  const gap = force ? FORCED_POLL_GAP_MS : pollGapMs(source.errorCount);
  const leaseEnd = new Date(now.getTime() + POLL_LEASE_MS);
  const claimed = await db.inboundMailSource.updateMany({
    where: {
      id: source.id,
      paused: false,
      OR: [{ lastCheckedAt: null }, { lastCheckedAt: { lt: new Date(now.getTime() - gap) } }],
    },
    data: { lastCheckedAt: leaseEnd },
  });
  return claimed.count === 1 ? leaseEnd : null;
}

function keywordsAllowed(client: ImapClientLike): boolean {
  const flags = client.mailbox ? client.mailbox.permanentFlags : undefined;
  // Unknown (no PERMANENTFLAGS reported): try the keyword; imapflow drops it if not allowed.
  return !flags || flags.size === 0 || flags.has("\\*") || flags.has(PROCESSED_KEYWORD);
}

async function markProcessed(
  client: ImapClientLike,
  uids: number[],
  processedFolder: string,
): Promise<"moved" | "flagged" | "flagged-no-keyword" | "failed"> {
  if (uids.length === 0) return "moved";
  const wanted = processedFolder.toLowerCase();
  try {
    // Servers with a personal namespace list it as e.g. "INBOX.FeedFerret";
    // imapflow adds that prefix itself on CREATE / MOVE.
    const folders = await client.list();
    const exists = folders.some(({ path }) => {
      const p = path.toLowerCase();
      return p === wanted || p.endsWith(`.${wanted}`) || p.endsWith(`/${wanted}`);
    });
    if (!exists) {
      await client.mailboxCreate(processedFolder).catch(() => undefined);
    }
    // imapflow reports a failed MOVE (or COPY+EXPUNGE fallback) as `false`, not as an exception.
    if ((await client.messageMove(uids, processedFolder, { uid: true })) === false) throw new Error("MOVE failed");
    return "moved";
  } catch (error) {
    logger.warn("[newsletter-imap] move failed, flagging instead", { code: classifyImapError(error) });
  }
  // Fallback: our keyword (+ \Seen \Flagged). Only a server that refuses
  // custom keywords gets plain \Seen + \Flagged, and that is remembered.
  if (keywordsAllowed(client)) {
    const ok = await client.messageFlagsAdd(uids, ["\\Seen", "\\Flagged", PROCESSED_KEYWORD], { uid: true }).catch(() => false);
    // Some servers accept the STORE but silently drop unknown keywords: check.
    if (ok !== false && (await keywordStuck(client, uids))) return "flagged";
  }
  const plain = await client.messageFlagsAdd(uids, ["\\Seen", "\\Flagged"], { uid: true }).catch(() => false);
  if (plain !== false) return "flagged-no-keyword";
  logger.warn("[newsletter-imap] could not mark processed mail; Message-ID dedupe keeps it from being stored twice");
  return "failed";
}

async function keywordStuck(client: ImapClientLike, uids: number[]): Promise<boolean> {
  try {
    let seen = 0;
    for await (const msg of client.fetch(uids, { uid: true, flags: true }, { uid: true })) {
      if (!msg.flags?.has(PROCESSED_KEYWORD)) return false;
      seen += 1;
    }
    return seen > 0;
  } catch {
    return false;
  }
}

/** Processed = our keyword; plain \Seen + \Flagged only on a server known to refuse keywords. */
export function alreadyProcessed(flags: Set<string> | undefined, keywordsUnsupported = false): boolean {
  if (!flags) return false;
  if (flags.has(PROCESSED_KEYWORD)) return true;
  return keywordsUnsupported && flags.has("\\Seen") && flags.has("\\Flagged");
}

/**
 * Owners of the ACTIVE addresses among `tokens` (same rule as ingestRawEmail
 * routing) and which of them already used up today's quota — once per poll,
 * before any download.
 */
async function activeOwnersAndQuota(tokens: string[]): Promise<{ tokenUser: Map<string, string>; full: Set<string> }> {
  const tokenUser = new Map<string, string>();
  const full = new Set<string>();
  if (tokens.length === 0) return { tokenUser, full };
  const rows: { token: string; userId: string }[] = [];
  for (let i = 0; i < tokens.length; i += 500) {
    rows.push(...(await db.newsletterAddress.findMany({ where: { token: { in: tokens.slice(i, i + 500) }, isActive: true }, select: { token: true, userId: true } })));
  }
  for (const r of rows) tokenUser.set(r.token, r.userId);
  const userIds = [...new Set(rows.map((r) => r.userId))];
  if (userIds.length > 0) {
    const quotas = await db.newsletterQuota.findMany({ where: { userId: { in: userIds }, day: quotaDay() }, select: { userId: true, count: true } });
    for (const q of quotas) if (q.count >= MAX_NEWSLETTER_MAILS_PER_DAY) full.add(q.userId);
  }
  return { tokenUser, full };
}

export interface PollOptions extends ImapDeps {
  /** Wizard live test: ignore the regular interval/backoff (a short gap still applies). */
  force?: boolean;
  ingest?: (raw: Buffer, options: { recipients: string[]; trustedAuthservId: string | null }) => Promise<IngestResult>;
  /** Tests: shorter total deadline / grace. */
  totalTimeoutMs?: number;
  graceMs?: number;
}

type Candidate = { uid: number; size: number; recipients: string[]; tokens: string[] };

export async function pollImapSource(source: SourceRow, options: PollOptions = {}): Promise<PollSummary> {
  const clock = () => options.now?.() ?? new Date();
  const now = clock();
  const summary: PollSummary = { sourceId: source.id, status: "skipped", scanned: 0, matched: 0, created: 0, moved: 0, deferred: 0, junk: 0, outOfWindow: 0 };
  if (source.kind !== "imap") return summary;
  if (source.paused) return { ...summary, status: "paused" };
  const leaseEnd = await claimSource(source, !!options.force, now);
  if (!leaseEnd) return summary;

  const settings = parseImapSettings(source.settings);
  const credentials = openImapCredentials(source.credentials);
  const created: { userId: string; articleId: string }[] = [];
  let client: ImapClientLike | null = null;
  let aborted = false;
  let settingsPatch: Partial<ImapSourceSettings> | null = null;

  const work = async () => {
    if (!settings || !source.address) throw new ImapPollError("unknown", "IMAP source is incomplete");
    if (!credentials) throw new ImapPollError("credentials-unreadable", "IMAP credentials cannot be read (key changed?)");
    const trustedAuthservId = trustedAuthservIdForPreset(settings.presetId);
    const ingest = options.ingest ?? ((raw, o) => ingestRawEmail(raw, o));
    const mailbox = source.address;

    client = await connectClient({ host: settings.host, port: settings.port, secure: settings.secure, user: credentials.user, pass: credentials.pass }, options);
    let lock: { release(): void };
    try {
      lock = await client.getMailboxLock(settings.folder);
    } catch (error) {
      throw new ImapPollError("folder", `Folder cannot be opened (${classifyImapError(error)})`);
    }
    try {
      const since = new Date(now.getTime() - SCAN_DAYS * 24 * 60 * 60_000);
      // Processed mail is excluded on the server, so held-back mail is not
      // pushed out of the window by mail we already handled.
      const query = settings.keywordsUnsupported
        ? { since, deleted: false, or: [{ seen: false }, { flagged: false }] }
        : { since, deleted: false, unKeyword: PROCESSED_KEYWORD };
      const found = (await client.search(query, { uid: true })) || [];
      const sorted = found.sort((a, b) => a - b);
      const uids = sorted.slice(-SCAN_UID_LIMIT);
      summary.scanned = uids.length;
      summary.outOfWindow = sorted.length - uids.length;
      if (summary.outOfWindow > 0) {
        logger.warn("[newsletter-imap] unprocessed mail outside the scan window", { sourceId: source.id, outOfWindow: summary.outOfWindow });
      }
      if (uids.length === 0) return;

      const candidates: Candidate[] = [];
      for await (const msg of client.fetch(uids, { uid: true, flags: true, size: true, headers: [...RECIPIENT_HEADERS] }, { uid: true })) {
        if (alreadyProcessed(msg.flags, settings.keywordsUnsupported)) continue;
        const { addresses, tokens } = mailboxRecipients(recipientHeaderValues(msg.headers), mailbox, settings.presetId);
        if (addresses.length === 0) continue; // not ours: never touched
        // Same bound as ingestRawEmail: only the first 10 tokens of a mail route it.
        candidates.push({ uid: msg.uid, size: msg.size ?? 0, recipients: addresses, tokens: tokens.slice(0, 10) });
      }
      summary.matched = candidates.length;

      // Quota check BEFORE any download: an over-quota user's mail stays in
      // the inbox (for tomorrow) without costing a download or a poll slot.
      const { tokenUser, full } = await activeOwnersAndQuota([...new Set(candidates.flatMap((c) => c.tokens))]);
      const owner = (c: Candidate) => c.tokens.map((t) => tokenUser.get(t)).find(Boolean) ?? null;
      const perToken = new Map<string, number>();

      const done: number[] = [];
      let processed = 0;
      try {
        for (const candidate of candidates) {
          const userId = owner(candidate);
          // No ACTIVE address behind any token (guessed, revoked, deleted):
          // ingest would drop it anyway. Mark it processed without download
          // and without using a slot, so junk cannot starve real mail.
          if (!userId) {
            done.push(candidate.uid);
            summary.junk += 1;
            continue;
          }
          if (aborted || processed >= MAX_MESSAGES_PER_POLL) {
            summary.deferred += 1;
            continue;
          }
          if (full.has(userId)) {
            summary.deferred += 1;
            continue;
          }
          const tokenKey = candidate.tokens[0] ?? "";
          if ((perToken.get(tokenKey) ?? 0) >= MAX_MESSAGES_PER_TOKEN_PER_POLL) {
            summary.deferred += 1;
            continue;
          }
          perToken.set(tokenKey, (perToken.get(tokenKey) ?? 0) + 1);
          processed += 1;
          if (candidate.size > MAX_RAW_EMAIL_BYTES) {
            logger.warn("[newsletter-imap] oversized mail skipped", { sourceId: source.id, bytes: candidate.size });
            done.push(candidate.uid);
            continue;
          }
          const message = await client.fetchOne(String(candidate.uid), { uid: true, source: true }, { uid: true });
          if (!message || !message.source) continue;
          if (aborted) {
            summary.deferred += 1;
            continue;
          }
          // Throws only on infrastructure errors (DB down): stop, keep the rest for the next poll.
          const result = await ingest(message.source, { recipients: candidate.recipients, trustedAuthservId });
          if (result.status === "rate-limited") {
            // The quota filled up during this poll: skip this user's remaining mail, no slot used.
            processed -= 1;
            summary.deferred += 1;
            if (result.userId) full.add(result.userId);
            continue;
          }
          done.push(candidate.uid);
          if (result.status === "created" && result.userId && result.articleId) {
            created.push({ userId: result.userId, articleId: result.articleId });
          }
        }
      } finally {
        if (done.length > 0) {
          const how = await markProcessed(client, done, settings.processedFolder);
          if (how !== "failed") summary.moved = done.length;
          if (how === "flagged-no-keyword" && !settings.keywordsUnsupported) settingsPatch = { keywordsUnsupported: true };
          if (summary.junk > 0) logger.info("[newsletter-imap] mail to unknown/inactive addresses set aside", { sourceId: source.id, junk: summary.junk });
        }
      }
    } finally {
      lock.release();
    }
  };

  // Total deadline: first ask the loop to stop (it finishes the current mail
  // and marks what it did); only if that does not happen within the grace
  // period is the connection torn down.
  const total = options.totalTimeoutMs ?? POLL_TOTAL_TIMEOUT_MS;
  const grace = options.graceMs ?? POLL_GRACE_MS;
  const sleep = (ms: number) =>
    new Promise<"timeout">((resolve) => {
      const t = setTimeout(() => resolve("timeout"), ms);
      t.unref?.();
    });
  let failure: unknown = null;
  try {
    const running = work().then(() => "done" as const);
    let outcome = await Promise.race([running, sleep(total)]);
    if (outcome === "timeout") {
      aborted = true;
      summary.partial = true;
      outcome = await Promise.race([running, sleep(grace)]);
      if (outcome === "timeout") {
        try {
          (client as ImapClientLike | null)?.close();
        } catch {
          /* already closed */
        }
        running.catch(() => undefined);
        throw new ImapPollError("timeout", `IMAP did not finish within ${Math.round(total / 1000)} s`);
      }
    }
  } catch (error) {
    failure = error;
  } finally {
    await closeQuietly(client);
  }

  summary.created = created.length;
  const finishedAt = clock();
  const progress = created.length > 0 || summary.moved > 0;
  const code = failure ? classifyImapError(failure) : null;
  // A timeout after real progress is a slow mailbox, not a broken one: no backoff.
  const hardError = !!failure && !(code === "timeout" && progress);
  // The only settings change a poll makes is keywordsUnsupported, merged
  // into the CURRENT row (an admin may have changed host/port meanwhile).
  let settingsJson: string | undefined;
  if (settingsPatch) {
    const current = await db.inboundMailSource.findUnique({ where: { id: source.id }, select: { settings: true } }).catch(() => null);
    const parsed = (() => {
      try {
        return current?.settings ? (JSON.parse(current.settings) as Record<string, unknown>) : null;
      } catch {
        return null;
      }
    })();
    if (parsed) settingsJson = JSON.stringify({ ...parsed, ...(settingsPatch as object) });
  }
  const bookkeeping = {
    lastCheckedAt: finishedAt,
    ...(created.length > 0 ? { lastReceivedAt: finishedAt } : {}),
    ...(settingsJson ? { settings: settingsJson } : {}),
  };
  // Guarded by our own lease: if it ran out and another poll claimed the
  // source, this (late) finish must not overwrite that poll's state.
  const finish = (data: Record<string, unknown>) =>
    db.inboundMailSource.updateMany({ where: { id: source.id, lastCheckedAt: leaseEnd }, data }).then((r) => {
      if (r.count !== 1) logger.warn("[newsletter-imap] lease lost before finish; bookkeeping skipped", { sourceId: source.id });
    });
  if (hardError) {
    const detail = redactImapError(String((failure as { responseText?: string })?.responseText || (failure as Error)?.message || ""), [credentials?.pass, credentials?.user]);
    summary.status = "error";
    summary.errorCode = code!;
    logger.warn("[newsletter-imap] poll failed", { sourceId: source.id, code });
    await finish({ ...bookkeeping, errorCount: { increment: 1 }, lastError: formatStoredError(code!, detail) }).catch(() => undefined);
  } else {
    summary.status = "ok";
    if (failure || summary.partial) summary.partial = true;
    await finish({ ...bookkeeping, errorCount: 0, lastError: null }).catch((e) => logger.error("[newsletter-imap] bookkeeping failed:", e));
  }

  // Everything that was actually created gets its hooks, also after a timeout.
  // Residual risk (accepted): if ingest hangs past the grace period the
  // connection is torn down and an article created by that very call after
  // this point gets no auto-read / alert / push hooks (it is still stored and
  // visible). Bounded by the 10 MB parse limit; not worth a cross-poll queue.
  if (created.length > 0) await afterIngest(created);
  if (summary.matched > 0 || summary.status === "error" || summary.partial) {
    logger.info("[newsletter-imap] poll", {
      sourceId: source.id,
      status: summary.status,
      matched: summary.matched,
      created: summary.created,
      moved: summary.moved,
      deferred: summary.deferred,
      outOfWindow: summary.outOfWindow,
      partial: !!summary.partial,
    });
  }
  return summary;
}

/** Poll every active IMAP source (background job). Never throws. */
export async function pollInboundSources(options: PollOptions = {}): Promise<PollSummary[]> {
  let sources: SourceRow[];
  try {
    sources = await db.inboundMailSource.findMany({ where: { kind: "imap", paused: false }, select: SOURCE_SELECT });
  } catch (error) {
    logger.error("[newsletter-imap] cannot load sources:", error);
    return [];
  }
  const results: PollSummary[] = [];
  for (const source of sources) {
    results.push(await pollImapSource(source, options));
  }
  return results;
}

/** Poll one source now (wizard live test). */
export async function pollInboundSourceNow(sourceId: string, options: PollOptions = {}): Promise<PollSummary | null> {
  const source = await db.inboundMailSource.findUnique({ where: { id: sourceId }, select: SOURCE_SELECT });
  if (!source) return null;
  return pollImapSource(source, { ...options, force: true });
}
