// N1 PR B: IMAP poller with a mocked imapflow client — recipient filtering,
// processed-folder move / flag fallback, lock, backoff bookkeeping, error
// classification + redaction, host pinning and autodiscovery. No network.
import { beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => {
  const source = {
    id: "src1",
    kind: "imap",
    address: "news.box@gmail.com",
    settings: JSON.stringify({ host: "imap.gmail.com", port: 993, secure: true, folder: "INBOX", presetId: "gmail", processedFolder: "FeedFerret" }),
    credentials: "ff2.sealed",
    paused: false,
    errorCount: 0,
    lastCheckedAt: null as Date | null,
  };
  const db = {
    inboundMailSource: {
      updateMany: vi.fn(async () => ({ count: 1 })),
      update: vi.fn(async () => ({})),
      findMany: vi.fn(async () => [source]),
      findUnique: vi.fn(async () => source),
    },
    newsletterAddress: { findMany: vi.fn(async (_args: unknown): Promise<{ token: string; userId: string }[]> => []) },
    newsletterQuota: { findMany: vi.fn(async (_args: unknown): Promise<{ userId: string; count: number }[]> => []) },
  };
  return { source, db, hooks: { autoRead: vi.fn(async () => ({ applied: 0 })), alerts: vi.fn(async () => undefined), push: vi.fn(async () => undefined) } };
});

vi.mock("@/lib/db", () => ({ db: h.db }));
vi.mock("@/lib/secret-box", () => ({
  sealSecret: (_purpose: string, value: string) => `ff2.${Buffer.from(value).toString("base64")}`,
  readPlainColumnState: (_purpose: string, stored: string | null) =>
    stored ? { value: JSON.stringify({ user: "news.box@gmail.com", pass: "hunter2-app-pass" }), unreadable: false } : { value: null, unreadable: false },
}));
vi.mock("@/lib/ssrf", () => ({ isTrustedFeedFetchingAllowed: vi.fn(async () => false) }));
vi.mock("@/lib/auto-read-rules", () => ({ applyAutoReadRules: h.hooks.autoRead }));
vi.mock("@/lib/keyword-alerts", () => ({ applyKeywordAlerts: h.hooks.alerts }));
vi.mock("@/lib/notifications", () => ({ queueNewArticleNotifications: h.hooks.push }));

import {
  alreadyProcessed,
  classifyImapError,
  POLL_LEASE_MS,
  discoverImapServer,
  mailboxRecipients,
  parseHeaderBlock,
  pinImapHost,
  pollGapMs,
  pollImapSource,
  recipientHeaderValues,
  redactImapError,
  storedErrorCode,
  testImapConnection,
  type ImapClientLike,
} from "@/lib/inbound-email-poller";

const TOKEN_A = "a".repeat(26);
const TOKEN_B = "b".repeat(26);
const publicLookup = async () => [{ address: "142.250.1.108", family: 4 }];

type FakeMsg = { uid: number; headers: string; flags?: string[]; size?: number; source?: string };

function fakeClient(messages: FakeMsg[], opts: { moveFails?: boolean | "throw"; folders?: string[]; connectError?: unknown; permanentFlags?: string[]; slowFetchMs?: number } = {}) {
  const calls = { moved: [] as number[][], flagged: [] as { uids: number[]; flags: string[] }[], created: [] as string[], fetchedSource: [] as number[], options: null as unknown };
  const folders = [...(opts.folders ?? ["INBOX"])];
  const client: ImapClientLike = {
    mailbox: opts.permanentFlags ? { permanentFlags: new Set(opts.permanentFlags) } : undefined,
    connect: vi.fn(async () => {
      if (opts.connectError) throw opts.connectError;
    }),
    list: vi.fn(async () => folders.map((path) => ({ path }))),
    getMailboxLock: vi.fn(async () => ({ release: vi.fn() })),
    search: vi.fn(async () => messages.map((m) => m.uid)),
    fetch: (uids) =>
      (async function* () {
        for (const m of messages) {
          if ((uids as number[]).includes(m.uid)) yield { uid: m.uid, flags: new Set(m.flags ?? []), size: m.size ?? 100, headers: Buffer.from(m.headers) };
        }
      })(),
    fetchOne: vi.fn(async (uid: string) => {
      if (opts.slowFetchMs) await new Promise((r) => setTimeout(r, opts.slowFetchMs));
      calls.fetchedSource.push(Number(uid));
      const m = messages.find((x) => x.uid === Number(uid));
      return m ? { uid: m.uid, source: Buffer.from(m.source ?? `${m.headers}\r\n\r\nbody`) } : false;
    }),
    mailboxCreate: vi.fn(async (path: string) => {
      calls.created.push(path);
      folders.push(path);
    }),
    // Like imapflow: a failed MOVE resolves to `false` (or throws on a dead connection).
    messageMove: vi.fn(async (uids) => {
      if (opts.moveFails === "throw") throw new Error("connection lost");
      if (opts.moveFails) return false;
      calls.moved.push(uids as number[]);
      return { path: "INBOX" };
    }),
    messageFlagsAdd: vi.fn(async (uids, flags: string[]) => {
      calls.flagged.push({ uids: uids as number[], flags });
    }),
    logout: vi.fn(async () => undefined),
    close: vi.fn(),
  };
  const factory = vi.fn((options: unknown) => {
    calls.options = options;
    return client;
  });
  return { client, factory, calls };
}

beforeEach(() => {
  vi.clearAllMocks();
  h.db.inboundMailSource.updateMany.mockResolvedValue({ count: 1 });
  h.db.newsletterAddress.findMany.mockResolvedValue([]);
  h.db.newsletterQuota.findMany.mockResolvedValue([]);
});

describe("recipient filtering", () => {
  it("accepts only +ff-<token> addresses of THIS mailbox (gmail dots + googlemail alias)", () => {
    const values = [
      `Newsletter <news.box+ff-${TOKEN_A}@gmail.com>`,
      `newsbox+ff-${TOKEN_B}@googlemail.com`,
      `someone.else+ff-${TOKEN_A}@gmail.com`, // other mailbox
      `news.box+ff-short@gmail.com`, // malformed token
      `news.box@gmail.com`, // no tag
      `news.box+ff-${TOKEN_A}@example.org`, // other domain
    ];
    const r = mailboxRecipients(values, "news.box@gmail.com", "gmail");
    expect(r.tokens).toEqual([TOKEN_A, TOKEN_B]);
    expect(r.addresses).toEqual([`news.box+ff-${TOKEN_A}@gmail.com`, `newsbox+ff-${TOKEN_B}@googlemail.com`]);
  });

  it("does not ignore dots for non-Gmail providers", () => {
    expect(mailboxRecipients([`newsbox+ff-${TOKEN_A}@posteo.de`], "news.box@posteo.de").tokens).toEqual([]);
    expect(mailboxRecipients([`news.box+ff-${TOKEN_A}@posteo.de`], "news.box@posteo.de").tokens).toEqual([TOKEN_A]);
  });

  it("reads folded recipient headers and ignores others", () => {
    const raw = `Delivered-To: x+ff-${TOKEN_A}@ex.org\r\nSubject: hi x+ff-${TOKEN_B}@ex.org\r\nTo: A <a@ex.org>,\r\n  B <x+ff-${TOKEN_B}@ex.org>\r\n\r\nbody`;
    expect(parseHeaderBlock(raw).map((x) => x.key)).toEqual(["delivered-to", "subject", "to"]);
    expect(mailboxRecipients(recipientHeaderValues(raw), "x@ex.org").tokens).toEqual([TOKEN_A, TOKEN_B]);
  });
});

describe("errors", () => {
  it("classifies imapflow errors into wizard codes", () => {
    expect(classifyImapError({ authenticationFailed: true, responseText: "[ALERT] Application-specific password required" })).toBe("app-password-required");
    expect(classifyImapError({ authenticationFailed: true, responseText: "[ALERT] Your account is not enabled for IMAP use." })).toBe("imap-disabled");
    expect(classifyImapError({ authenticationFailed: true, serverResponseCode: "AUTHENTICATIONFAILED", responseText: "Invalid credentials" })).toBe("auth-failed");
    expect(classifyImapError({ code: "CONNECT_TIMEOUT" })).toBe("timeout");
    expect(classifyImapError({ tlsFailed: true })).toBe("tls");
    expect(classifyImapError({ code: "ERR_TLS_CERT_ALTNAME_INVALID" })).toBe("tls");
    expect(classifyImapError({ code: "ENOTFOUND" })).toBe("host-not-found");
    expect(classifyImapError({ code: "ECONNREFUSED" })).toBe("unreachable");
    expect(classifyImapError(new Error("weird"))).toBe("unknown");
  });

  it("redacts password, user, addresses and tokens", () => {
    const out = redactImapError(`LOGIN news.box@gmail.com hunter2-app-pass failed for x+ff-${TOKEN_A}@gmail.com`, ["hunter2-app-pass", "news.box@gmail.com"]);
    expect(out).not.toContain("hunter2");
    expect(out).not.toContain("news.box");
    expect(out).not.toContain(TOKEN_A);
    expect(storedErrorCode("auth-failed: nope")).toBe("auth-failed");
    expect(storedErrorCode(null)).toBeNull();
  });

  it("backs off exponentially, capped at an hour", () => {
    expect(pollGapMs(0)).toBeLessThan(2 * 60_000);
    expect(pollGapMs(1)).toBe(2 * 60_000);
    expect(pollGapMs(3)).toBe(8 * 60_000);
    expect(pollGapMs(20)).toBe(60 * 60_000);
  });
});

describe("host policy", () => {
  it("refuses private answers unless internal targets are allowed, and pins the IP", async () => {
    await expect(pinImapHost("imap.evil.test", { allowInternal: false, lookup: async () => [{ address: "93.184.216.34", family: 4 }, { address: "10.0.0.5", family: 4 }] })).rejects.toMatchObject({ code: "host-blocked" });
    await expect(pinImapHost("127.0.0.1", { allowInternal: false })).rejects.toMatchObject({ code: "host-blocked" });
    await expect(pinImapHost("localhost", { allowInternal: false })).rejects.toMatchObject({ code: "host-blocked" });
    await expect(pinImapHost("169.254.169.254", { allowInternal: false })).rejects.toMatchObject({ code: "host-blocked" });
    expect(await pinImapHost("mail.lan", { allowInternal: true, lookup: async () => [{ address: "192.168.1.2", family: 4 }] })).toEqual({ address: "192.168.1.2", servername: "mail.lan" });
    expect(await pinImapHost("IMAP.Gmail.com.", { allowInternal: false, lookup: publicLookup })).toEqual({ address: "142.250.1.108", servername: "imap.gmail.com" });
  });

  it("connects to the pinned IP with SNI + certificate check on the name, never cleartext", async () => {
    const { factory, calls } = fakeClient([]);
    const res = await testImapConnection({ host: "imap.example.org", port: 143, secure: false, user: "u@example.org", pass: "p" }, { clientFactory: factory, lookup: publicLookup, allowInternal: false });
    expect(res.ok).toBe(true);
    expect(calls.options).toMatchObject({ host: "142.250.1.108", servername: "imap.example.org", doSTARTTLS: true, logger: false, tls: { rejectUnauthorized: true, servername: "imap.example.org" } });
  });

  it("maps a blocked host to host-blocked without opening a socket", async () => {
    const { factory } = fakeClient([]);
    const res = await testImapConnection({ host: "10.1.2.3", port: 993, secure: true, user: "u", pass: "p" }, { clientFactory: factory, allowInternal: false });
    expect(res).toMatchObject({ ok: false, code: "host-blocked" });
    expect(factory).not.toHaveBeenCalled();
  });

  it("reports auth errors with redacted detail", async () => {
    const { factory } = fakeClient([], { connectError: Object.assign(new Error("Command failed"), { authenticationFailed: true, responseText: "Invalid credentials for u@example.org (pass sekret123)" }) });
    const res = await testImapConnection({ host: "imap.example.org", port: 993, secure: true, user: "u@example.org", pass: "sekret123" }, { clientFactory: factory, lookup: publicLookup, allowInternal: false });
    expect(res).toMatchObject({ ok: false, code: "auth-failed" });
    expect(JSON.stringify(res)).not.toContain("sekret123");
    expect(JSON.stringify(res)).not.toContain("u@example.org");
  });
});

describe("autodiscovery", () => {
  const none = async () => {
    throw Object.assign(new Error("nx"), { code: "ENOTFOUND" });
  };
  it("prefers presets, then SRV, then provider MX, then imap.<domain>", async () => {
    expect(await discoverImapServer("x@gmx.de")).toMatchObject({ host: "imap.gmx.net", presetId: "gmx", source: "preset" });
    expect(await discoverImapServer("x@corp.example", { resolveSrv: async () => [{ name: "mail.corp.example.", port: 993, priority: 0, weight: 0 }], resolveMx: none, lookup: none })).toMatchObject({ host: "mail.corp.example", port: 993, source: "srv" });
    expect(await discoverImapServer("x@corp.example", { resolveSrv: none, resolveMx: async () => [{ exchange: "aspmx.l.google.com", priority: 1 }], lookup: none })).toMatchObject({ host: "imap.gmail.com", presetId: "gmail", source: "mx" });
    expect(await discoverImapServer("x@corp.example", { resolveSrv: none, resolveMx: none, lookup: publicLookup })).toMatchObject({ host: "imap.corp.example", port: 993, source: "guess" });
    expect(await discoverImapServer("x@corp.example", { resolveSrv: none, resolveMx: none, lookup: none })).toBeNull();
    expect(await discoverImapServer("not-an-email")).toBeNull();
  });
});

describe("pollImapSource", () => {
  const hdr = (to: string) => `Delivered-To: ${to}\r\nTo: ${to}\r\nSubject: hi`;

  it("ingests only our messages, moves them to FeedFerret and runs the new-item hooks", async () => {
    const { factory, calls, client } = fakeClient([
      { uid: 1, headers: hdr(`news.box+ff-${TOKEN_A}@gmail.com`) },
      { uid: 2, headers: hdr("news.box@gmail.com") }, // private mail: untouched
      { uid: 3, headers: hdr(`news.box+ff-${TOKEN_B}@gmail.com`), flags: ["$FeedFerret"] }, // processed before
      { uid: 4, headers: hdr(`news.box+ff-${TOKEN_B}@gmail.com`) },
    ]);
    const ingest = vi.fn(async (_raw: Buffer, o: { recipients: string[]; trustedAuthservId: string | null }) =>
      o.recipients[0].includes(TOKEN_A) ? { status: "created" as const, userId: "u1", articleId: "a1" } : { status: "unknown-token" as const },
    );
    const summary = await pollImapSource({ ...h.source }, { clientFactory: factory, lookup: publicLookup, allowInternal: false, ingest });
    expect(summary).toMatchObject({ status: "ok", scanned: 4, matched: 2, created: 1, moved: 2 });
    expect(calls.fetchedSource).toEqual([1, 4]);
    expect(ingest.mock.calls[0][1]).toEqual({ recipients: [`news.box+ff-${TOKEN_A}@gmail.com`], trustedAuthservId: null });
    expect(calls.created).toEqual(["FeedFerret"]);
    expect(calls.moved).toEqual([[1, 4]]);
    expect(client.messageFlagsAdd).not.toHaveBeenCalled();
    expect(h.db.inboundMailSource.update).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ errorCount: 0, lastError: null, lastReceivedAt: expect.any(Date) }) }));
    expect(h.hooks.autoRead).toHaveBeenCalledWith("u1", { onlyArticleIds: ["a1"] });
    expect(h.hooks.alerts).toHaveBeenCalledWith("u1", ["a1"]);
    expect(h.hooks.push).toHaveBeenCalledWith("u1", ["a1"]);
  });

  it("falls back to \\Seen + \\Flagged + keyword when MOVE fails; leaves rate-limited mail", async () => {
    const { factory, calls } = fakeClient(
      [
        { uid: 7, headers: hdr(`news.box+ff-${TOKEN_A}@gmail.com`) },
        { uid: 8, headers: hdr(`news.box+ff-${TOKEN_B}@gmail.com`) },
      ],
      { moveFails: true, folders: ["INBOX", "FeedFerret"] },
    );
    const ingest = vi.fn(async (_raw: Buffer, o: { recipients: string[] }) =>
      o.recipients[0].includes(TOKEN_B) ? { status: "rate-limited" as const } : { status: "duplicate" as const },
    );
    const summary = await pollImapSource({ ...h.source }, { clientFactory: factory, lookup: publicLookup, allowInternal: false, ingest });
    expect(summary).toMatchObject({ status: "ok", matched: 2, moved: 1, created: 0 });
    expect(calls.flagged).toEqual([{ uids: [7], flags: ["\\Seen", "\\Flagged", "$FeedFerret"] }]);
    expect(h.hooks.autoRead).not.toHaveBeenCalled();
  });

  it("also flags when MOVE throws, and finds a namespaced processed folder", async () => {
    const { factory, calls } = fakeClient([{ uid: 5, headers: hdr(`news.box+ff-${TOKEN_A}@gmail.com`) }], { moveFails: "throw", folders: ["INBOX", "INBOX.FeedFerret"] });
    await pollImapSource({ ...h.source }, { clientFactory: factory, lookup: publicLookup, allowInternal: false, ingest: vi.fn(async () => ({ status: "duplicate" as const })) });
    expect(calls.created).toEqual([]);
    expect(calls.flagged).toEqual([{ uids: [5], flags: ["\\Seen", "\\Flagged", "$FeedFerret"] }]);
  });

  it("skips oversized mail without downloading it", async () => {
    const { factory, calls } = fakeClient([{ uid: 9, headers: hdr(`news.box+ff-${TOKEN_A}@gmail.com`), size: 11 * 1024 * 1024 }], { folders: ["INBOX", "FeedFerret"] });
    const ingest = vi.fn();
    const summary = await pollImapSource({ ...h.source }, { clientFactory: factory, lookup: publicLookup, allowInternal: false, ingest });
    expect(ingest).not.toHaveBeenCalled();
    expect(calls.fetchedSource).toEqual([]);
    expect(summary.moved).toBe(1);
  });

  it("does nothing when another poll holds the lock (conditional claim lost)", async () => {
    h.db.inboundMailSource.updateMany.mockResolvedValueOnce({ count: 0 });
    const { factory } = fakeClient([]);
    const summary = await pollImapSource({ ...h.source }, { clientFactory: factory, lookup: publicLookup, allowInternal: false });
    expect(summary.status).toBe("skipped");
    expect(factory).not.toHaveBeenCalled();
  });

  it("claims with the backoff gap for the current error count", async () => {
    const { factory } = fakeClient([]);
    const now = new Date("2026-11-11T10:00:00Z");
    await pollImapSource({ ...h.source, errorCount: 3 }, { clientFactory: factory, lookup: publicLookup, allowInternal: false, now: () => now });
    const call = (h.db.inboundMailSource.updateMany.mock.calls[0] as unknown as [{ where: { OR: [unknown, { lastCheckedAt: { lt: Date } }] }; data: { lastCheckedAt: Date } }])[0];
    expect(call.where.OR[1].lastCheckedAt.lt.getTime()).toBe(now.getTime() - 8 * 60_000);
    // The claim holds a lease that covers the whole poll (a forced live-test poll cannot overlap it) …
    expect(call.data.lastCheckedAt.getTime()).toBe(now.getTime() + POLL_LEASE_MS);
    expect(POLL_LEASE_MS).toBeGreaterThan(60_000);
    // … and the finish writes the real time back.
    const done = (h.db.inboundMailSource.update.mock.calls.at(-1) as unknown as [{ data: { lastCheckedAt: Date } }])[0].data;
    expect(done.lastCheckedAt.getTime()).toBe(now.getTime());
  });

  it("counts errors and stores a redacted message; never throws", async () => {
    const { factory } = fakeClient([], { connectError: Object.assign(new Error("x"), { authenticationFailed: true, responseText: "Invalid credentials hunter2-app-pass" }) });
    const summary = await pollImapSource({ ...h.source }, { clientFactory: factory, lookup: publicLookup, allowInternal: false });
    expect(summary).toMatchObject({ status: "error", errorCode: "auth-failed" });
    const data = (h.db.inboundMailSource.update.mock.calls.at(-1) as unknown as [{ data: { errorCount: unknown; lastError: string } }])[0].data;
    expect(data.errorCount).toEqual({ increment: 1 });
    expect(data.lastError.startsWith("auth-failed")).toBe(true);
    expect(data.lastError).not.toContain("hunter2");
  });

  it("an over-quota user cannot starve others: skipped before download, no poll slots used", async () => {
    const msgs: FakeMsg[] = [];
    for (let uid = 1; uid <= 60; uid++) msgs.push({ uid, headers: hdr(`news.box+ff-${TOKEN_A}@gmail.com`) });
    msgs.push({ uid: 61, headers: hdr(`news.box+ff-${TOKEN_B}@gmail.com`) });
    h.db.newsletterAddress.findMany.mockResolvedValue([{ token: TOKEN_A, userId: "uA" }, { token: TOKEN_B, userId: "uB" }]);
    h.db.newsletterQuota.findMany.mockResolvedValue([{ userId: "uA", count: 100 }]);
    const { factory, calls } = fakeClient(msgs, { folders: ["INBOX", "FeedFerret"] });
    const ingest = vi.fn(async () => ({ status: "created" as const, userId: "uB", articleId: "b1" }));
    const summary = await pollImapSource({ ...h.source }, { clientFactory: factory, lookup: publicLookup, allowInternal: false, ingest });
    expect(calls.fetchedSource).toEqual([61]);
    expect(ingest).toHaveBeenCalledTimes(1);
    expect(summary).toMatchObject({ status: "ok", matched: 61, created: 1, moved: 1, deferred: 60 });
    expect(calls.moved).toEqual([[61]]);
  });

  it("a quota that fills up DURING the poll stops that user's downloads; others still get through", async () => {
    const msgs: FakeMsg[] = [];
    for (let uid = 1; uid <= 60; uid++) msgs.push({ uid, headers: hdr(`news.box+ff-${TOKEN_A}@gmail.com`) });
    msgs.push({ uid: 61, headers: hdr(`news.box+ff-${TOKEN_B}@gmail.com`) });
    h.db.newsletterAddress.findMany.mockResolvedValue([{ token: TOKEN_A, userId: "uA" }, { token: TOKEN_B, userId: "uB" }]);
    const { factory, calls } = fakeClient(msgs, { folders: ["INBOX", "FeedFerret"] });
    const ingest = vi.fn(async (_raw: Buffer, o: { recipients: string[] }) =>
      o.recipients[0].includes(TOKEN_A) ? { status: "rate-limited" as const, userId: "uA" } : { status: "created" as const, userId: "uB", articleId: "b1" },
    );
    const summary = await pollImapSource({ ...h.source }, { clientFactory: factory, lookup: publicLookup, allowInternal: false, ingest });
    expect(calls.fetchedSource).toEqual([1, 61]); // A's first mail revealed the full quota; the other 59 are not downloaded
    expect(summary).toMatchObject({ created: 1, moved: 1, deferred: 60 });
  });

  it("caps mail per address and per poll", async () => {
    const msgs: FakeMsg[] = [];
    for (let uid = 1; uid <= 30; uid++) msgs.push({ uid, headers: hdr(`news.box+ff-${TOKEN_A}@gmail.com`) });
    for (let uid = 31; uid <= 35; uid++) msgs.push({ uid, headers: hdr(`news.box+ff-${TOKEN_B}@gmail.com`) });
    const { factory, calls } = fakeClient(msgs, { folders: ["INBOX", "FeedFerret"] });
    const summary = await pollImapSource({ ...h.source }, { clientFactory: factory, lookup: publicLookup, allowInternal: false, ingest: vi.fn(async () => ({ status: "duplicate" as const })) });
    expect(calls.fetchedSource.filter((u) => u <= 30)).toHaveLength(20);
    expect(calls.fetchedSource.filter((u) => u > 30)).toHaveLength(5);
    expect(summary.deferred).toBe(10);
  });

  it("excludes processed mail server-side and reports mail outside the scan window", async () => {
    const msgs: FakeMsg[] = [];
    for (let uid = 1; uid <= 310; uid++) msgs.push({ uid, headers: hdr("news.box@gmail.com") });
    const { factory, client } = fakeClient(msgs);
    const summary = await pollImapSource({ ...h.source }, { clientFactory: factory, lookup: publicLookup, allowInternal: false });
    expect((client.search as ReturnType<typeof vi.fn>).mock.calls[0][0]).toMatchObject({ deleted: false, unKeyword: "$FeedFerret" });
    expect(summary).toMatchObject({ scanned: 300, outOfWindow: 10 });
  });

  it("treats plain \\Seen+\\Flagged as processed only on servers that refuse keywords, and remembers that", async () => {
    expect(alreadyProcessed(new Set(["\\Seen", "\\Flagged"]))).toBe(false);
    expect(alreadyProcessed(new Set(["$FeedFerret"]))).toBe(true);
    expect(alreadyProcessed(new Set(["\\Seen", "\\Flagged"]), true)).toBe(true);

    const { factory, calls } = fakeClient([{ uid: 3, headers: hdr(`news.box+ff-${TOKEN_A}@gmail.com`) }], { moveFails: true, folders: ["INBOX", "FeedFerret"], permanentFlags: ["\\Seen", "\\Flagged", "\\Deleted"] });
    await pollImapSource({ ...h.source }, { clientFactory: factory, lookup: publicLookup, allowInternal: false, ingest: vi.fn(async () => ({ status: "duplicate" as const })) });
    expect(calls.flagged).toEqual([{ uids: [3], flags: ["\\Seen", "\\Flagged"] }]);
    const data = (h.db.inboundMailSource.update.mock.calls.at(-1) as unknown as [{ data: { settings: string } }])[0].data;
    expect(JSON.parse(data.settings)).toMatchObject({ keywordsUnsupported: true });

    // With the remembered setting the search excludes \Seen+\Flagged mail instead.
    const remembered = { ...h.source, settings: data.settings };
    const second = fakeClient([]);
    await pollImapSource(remembered, { clientFactory: second.factory, lookup: publicLookup, allowInternal: false });
    expect((second.client.search as ReturnType<typeof vi.fn>).mock.calls[0][0]).toMatchObject({ or: [{ seen: false }, { flagged: false }] });
  });

  it("a timeout stops before the next ingest, keeps what was done, runs the hooks and does not back off", async () => {
    const msgs: FakeMsg[] = [1, 2, 3, 4].map((uid) => ({ uid, headers: hdr(`news.box+ff-${TOKEN_A}@gmail.com`) }));
    const { factory, calls } = fakeClient(msgs, { folders: ["INBOX", "FeedFerret"], slowFetchMs: 40 });
    let n = 0;
    const ingest = vi.fn(async () => ({ status: "created" as const, userId: "u1", articleId: `a${++n}` }));
    const summary = await pollImapSource({ ...h.source }, { clientFactory: factory, lookup: publicLookup, allowInternal: false, ingest, totalTimeoutMs: 60, graceMs: 1000 });
    expect(summary.partial).toBe(true);
    expect(summary.status).toBe("ok");
    expect(ingest.mock.calls.length).toBeGreaterThan(0);
    expect(ingest.mock.calls.length).toBeLessThan(4);
    expect(calls.moved[0]).toHaveLength(ingest.mock.calls.length);
    expect(h.hooks.autoRead).toHaveBeenCalledWith("u1", { onlyArticleIds: ingest.mock.results.map((_, i) => `a${i + 1}`) });
    const data = (h.db.inboundMailSource.update.mock.calls.at(-1) as unknown as [{ data: { errorCount: unknown } }])[0].data;
    expect(data.errorCount).toBe(0);
  });

  it("skips paused sources and blocked hosts", async () => {
    const { factory } = fakeClient([]);
    expect((await pollImapSource({ ...h.source, paused: true }, { clientFactory: factory })).status).toBe("paused");
    const blocked = await pollImapSource(
      { ...h.source, settings: JSON.stringify({ host: "10.0.0.1", port: 993, secure: true }) },
      { clientFactory: factory, allowInternal: false },
    );
    expect(blocked).toMatchObject({ status: "error", errorCode: "host-blocked" });
    expect(factory).not.toHaveBeenCalled();
  });
});
