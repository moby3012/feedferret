// N1 PR B: wizard + user newsletter actions — admin-only gate, pickFields,
// "__keep__" password handling, no credentials in responses, ownership.
import { beforeEach, describe, expect, it, vi } from "vitest";

type Address = { id: string; userId: string; token: string; description: string | null; isActive: boolean; lastReceivedAt: Date | null; createdAt: Date };

const h = vi.hoisted(() => {
  const store = {
    session: { id: "admin" } as { id: string } | null,
    users: {
      admin: { role: "ADMIN", isActive: true, twoFactorEnabled: false },
      bob: { role: "USER", isActive: true, twoFactorEnabled: false },
      eve: { role: "USER", isActive: true, twoFactorEnabled: false },
    } as Record<string, { role: string; isActive: boolean; twoFactorEnabled: boolean }>,
    rows: [] as Record<string, any>[],
    /** The active IMAP row (kind "imap"); setting null clears every row. */
    get source(): Record<string, any> | null {
      return this.rows.find((r) => r.kind === "imap") ?? null;
    },
    set source(value: Record<string, any> | null) {
      this.rows = value ? [value] : [];
    },
    addresses: [] as Address[],
    seq: 0,
  };
  const pick = (row: Record<string, unknown>, select?: Record<string, boolean>) =>
    select ? Object.fromEntries(Object.keys(select).map((k) => [k, row[k]])) : row;
  const addrMatch = (a: Address, where: any = {}) =>
    (where.userId === undefined || a.userId === where.userId) &&
    (where.isActive === undefined || a.isActive === where.isActive) &&
    (where.id === undefined || (typeof where.id === "string" ? a.id === where.id : a.id !== where.id.not)) &&
    (where.token?.in === undefined || where.token.in.includes(a.token));
  const kindMatches = (kind: string, where: any) =>
    where === undefined || (typeof where === "string" ? kind === where : where.in ? where.in.includes(kind) : where.not ? kind !== where.not : true);
  const db = {
    user: { findUnique: vi.fn(async ({ where }: any) => store.users[where.id] ?? null) },
    globalSettings: { findUnique: vi.fn(async () => ({ require2FAForAdmins: false })) },
    article: {
      rows: [] as { userId: string; title: string; createdAt: Date }[],
      findFirst: vi.fn(async ({ where }: any) =>
        db.article.rows.find((r) => r.userId === where.userId && r.title.includes(where.title.contains) && r.createdAt >= where.createdAt.gte) ?? null,
      ),
    },
    adminAuditLog: { create: vi.fn(async () => ({})) },
    inboundMailSource: {
      findFirst: vi.fn(async ({ where, select }: any) => {
        const row = store.rows.find((r) => kindMatches(r.kind, where?.kind));
        return row ? pick(row, select) : null;
      }),
      findMany: vi.fn(async ({ where }: any = {}) => store.rows.filter((r) => kindMatches(r.kind, where?.kind))),
      create: vi.fn(async ({ data, select }: any) => {
        const row = { id: `src${store.rows.length + 1}`, createdAt: new Date(), updatedAt: new Date(), lastReceivedAt: null, lastCheckedAt: null, ...data };
        store.rows.push(row);
        return pick(row, select);
      }),
      update: vi.fn(async ({ where, data, select }: any) => {
        const row = store.rows.find((r) => r.id === where.id)!;
        Object.assign(row, data);
        return pick(row, select);
      }),
      deleteMany: vi.fn(async ({ where }: any) => {
        const before = store.rows.length;
        store.rows = store.rows.filter((r) => !kindMatches(r.kind, where.kind));
        return { count: before - store.rows.length };
      }),
    },
    newsletterAddress: {
      findFirst: vi.fn(async ({ where }: any) => store.addresses.find((a) => addrMatch(a, where)) ?? null),
      findMany: vi.fn(async ({ where }: any) => store.addresses.filter((a) => addrMatch(a, where))),
      findUnique: vi.fn(async ({ where }: any) => store.addresses.find((a) => a.id === where.id) ?? null),
      count: vi.fn(async (args?: any) => store.addresses.filter((a) => addrMatch(a, args?.where)).length),
      create: vi.fn(async ({ data }: any) => {
        if (data.id && store.addresses.some((a) => a.id === data.id)) throw new Error("Unique constraint failed on id");
        const row: Address = { id: `addr${++store.seq}`, description: null, isActive: true, lastReceivedAt: null, createdAt: new Date(Date.now() + store.seq), ...data };
        store.addresses.push(row);
        return { id: row.id, token: row.token };
      }),
      updateMany: vi.fn(async ({ where, data }: any) => {
        const hit = store.addresses.filter((a) => addrMatch(a, where));
        hit.forEach((a) => Object.assign(a, data));
        return { count: hit.length };
      }),
    },
  };
  const poller = {
    testImapConnection: vi.fn(async () => ({ ok: true, folders: ["INBOX"], processedFolderExists: false })),
    discoverImapServer: vi.fn(async (email: string) => (email.endsWith("@gmail.com") ? { host: "imap.gmail.com", port: 993, secure: true, presetId: "gmail", source: "preset" } : null)),
    pollInboundSourceNow: vi.fn(async () => null),
  };
  return { store, db, poller };
});

vi.mock("@/auth", () => ({ auth: vi.fn(async () => (h.store.session ? { user: h.store.session } : null)) }));
vi.mock("@/lib/db", () => ({ db: h.db }));
vi.mock("@/lib/mail", () => ({ isMailServiceEnabled: vi.fn(async () => false), sendSystemEmail: vi.fn(async () => undefined) }));
vi.mock("@/lib/secret-box", () => ({
  sealSecret: (_p: string, v: string) => `ff2.${Buffer.from(v).toString("base64")}`,
  readPlainColumnState: (_p: string, stored: string | null) =>
    stored ? { value: Buffer.from(stored.slice(4), "base64").toString(), unreadable: false } : { value: null, unreadable: false },
}));
vi.mock("@/lib/inbound-email-poller", async (original) => ({
  ...(await original<typeof import("@/lib/inbound-email-poller")>()),
  testImapConnection: h.poller.testImapConnection,
  discoverImapServer: h.poller.discoverImapServer,
  pollInboundSourceNow: h.poller.pollInboundSourceNow,
}));
vi.mock("@/lib/ssrf", () => ({ isTrustedFeedFetchingAllowed: vi.fn(async () => false) }));
vi.mock("@/lib/auto-read-rules", () => ({ applyAutoReadRules: vi.fn() }));
vi.mock("@/lib/keyword-alerts", () => ({ applyKeywordAlerts: vi.fn() }));
vi.mock("@/lib/notifications", () => ({ queueNewArticleNotifications: vi.fn() }));

import * as admin from "@/app/actions/newsletter-admin";
import * as user from "@/app/actions/newsletter";

const as = (id: string | null) => {
  h.store.session = id ? { id } : null;
};

beforeEach(() => {
  vi.clearAllMocks();
  h.store.source = null;
  h.store.addresses = [];
  h.store.seq = 0;
  h.db.article.rows = [];
  h.store.users.admin.role = "ADMIN";
  as("admin");
});

describe("admin wizard actions", () => {
  const calls: [string, () => Promise<unknown>][] = [
    ["getNewsletterInboundState", () => admin.getNewsletterInboundState()],
    ["detectNewsletterImapServer", () => admin.detectNewsletterImapServer({ email: "a@gmail.com" })],
    ["testNewsletterImap", () => admin.testNewsletterImap({ email: "a@gmail.com", password: "x" })],
    ["saveNewsletterImap", () => admin.saveNewsletterImap({ email: "a@gmail.com", password: "x" })],
    ["startNewsletterTest", () => admin.startNewsletterTest({ send: true })],
    ["checkNewsletterTestMail", () => admin.checkNewsletterTestMail({ since: new Date().toISOString(), marker: "FF-TEST-AAAAAAAA" })],
    ["setNewsletterInboundPaused", () => admin.setNewsletterInboundPaused({ paused: true })],
    ["disconnectNewsletterInbound", () => admin.disconnectNewsletterInbound({ confirm: true })],
    ["saveNewsletterDomainSource", () => admin.saveNewsletterDomainSource({ kind: "cloudflare", domain: "news.example.org" })],
  ];

  it.each(calls)("%s rejects non-admins and anonymous callers", async (_name, call) => {
    as("bob");
    await expect(call()).rejects.toThrow(/Unauthorized/);
    as(null);
    await expect(call()).rejects.toThrow(/Unauthorized/);
    expect(h.db.inboundMailSource.create).not.toHaveBeenCalled();
    expect(h.db.inboundMailSource.update).not.toHaveBeenCalled();
    expect(h.db.inboundMailSource.deleteMany).not.toHaveBeenCalled();
    expect(h.poller.testImapConnection).not.toHaveBeenCalled();
  });

  it("saves only whitelisted fields and never returns the password", async () => {
    const res = await admin.saveNewsletterImap({ email: "News.Box@gmail.com", password: "app-pass-1", paused: true, kind: "webhook", credentials: "evil", errorCount: 99 });
    expect(res.ok).toBe(true);
    const data = h.db.inboundMailSource.create.mock.calls[0][0].data;
    expect(data).toMatchObject({ kind: "imap", address: "news.box@gmail.com", paused: false, errorCount: 0 });
    expect(data.credentials).not.toContain("app-pass-1");
    expect(JSON.parse(data.settings)).toMatchObject({ host: "imap.gmail.com", port: 993, secure: true, presetId: "gmail", processedFolder: "FeedFerret" });
    expect(JSON.stringify(res)).not.toContain("app-pass-1");
    expect(JSON.stringify(res)).not.toContain(data.credentials);
    expect(JSON.stringify(await admin.getNewsletterInboundState())).not.toContain(data.credentials);
  });

  it("does not store anything when the connection test fails", async () => {
    h.poller.testImapConnection.mockResolvedValueOnce({ ok: false, code: "app-password-required", detail: "" } as never);
    const res = await admin.saveNewsletterImap({ email: "a@gmail.com", password: "normal-password" });
    expect(res).toMatchObject({ ok: false, code: "app-password-required" });
    expect(h.db.inboundMailSource.create).not.toHaveBeenCalled();
  });

  it("reuses the stored password for __keep__ only for the same mailbox and server", async () => {
    await admin.saveNewsletterImap({ email: "a@gmail.com", password: "stored-pass" });
    h.poller.testImapConnection.mockClear();

    expect((await admin.testNewsletterImap({ email: "a@gmail.com", password: "__keep__" })).ok).toBe(true);
    expect(h.poller.testImapConnection).toHaveBeenLastCalledWith(expect.objectContaining({ pass: "stored-pass", host: "imap.gmail.com" }));

    // A typed-in host must never receive the stored password.
    h.poller.testImapConnection.mockClear();
    const moved = await admin.testNewsletterImap({ email: "a@gmail.com", password: "__keep__", host: "imap.attacker.example", port: 993 });
    expect(moved).toMatchObject({ ok: false, code: "password-required" });
    expect(h.poller.testImapConnection).not.toHaveBeenCalled();

    const otherBox = await admin.testNewsletterImap({ email: "b@gmail.com", password: "" });
    expect(otherBox).toMatchObject({ ok: false, code: "password-required" });
  });

  it("validates mailbox and manual server input", async () => {
    expect(await admin.testNewsletterImap({ email: "a+x@gmail.com", password: "p" })).toMatchObject({ ok: false, code: "invalid-email" });
    expect(await admin.testNewsletterImap({ email: "a@unknown.example", password: "p" })).toMatchObject({ ok: false, code: "no-server" });
    expect(await admin.testNewsletterImap({ email: "a@unknown.example", password: "p", host: "bad host!", port: 993 })).toMatchObject({ ok: false, code: "invalid-server" });
    expect(await admin.testNewsletterImap({ email: "a@unknown.example", password: "p", host: "mail.unknown.example", port: 70000 })).toMatchObject({ ok: false, code: "invalid-server" });
    expect((await admin.testNewsletterImap({ email: "a@unknown.example", password: "p", host: "mail.unknown.example", port: 143, secure: false })).ok).toBe(true);
    expect(h.poller.testImapConnection).toHaveBeenLastCalledWith(expect.objectContaining({ host: "mail.unknown.example", port: 143, secure: false }));
  });

  it("without a mailer the test step hands out the admin's own address and a unique subject marker", async () => {
    await admin.saveNewsletterImap({ email: "box@gmail.com", password: "p" });
    const res = await admin.startNewsletterTest({ send: true });
    expect(res).toMatchObject({ ok: true, sent: false });
    const ok = res as { address: string; marker: string };
    expect(ok.address).toMatch(/^box\+ff-[a-z2-7]{26}@gmail\.com$/);
    expect(ok.marker).toMatch(/^FF-TEST-[A-Z2-7]{8}$/);
    expect(((await admin.startNewsletterTest({})) as { marker: string }).marker).not.toBe(ok.marker);
    expect(h.store.addresses.every((a) => a.userId === "admin")).toBe(true);
  });

  it("detects arrival by this test's marker only — not by any other mail", async () => {
    await admin.saveNewsletterImap({ email: "box@gmail.com", password: "p" });
    const { startedAt, marker } = (await admin.startNewsletterTest({})) as { startedAt: string; marker: string };
    const at = (s: number) => new Date(new Date(startedAt).getTime() + s * 1000);
    // Some other newsletter (or an older test) arriving meanwhile does not count.
    h.db.article.rows.push({ userId: "admin", title: "Morning Brew", createdAt: at(3) }, { userId: "admin", title: "FeedFerret Testmail FF-TEST-OLDOLDOL", createdAt: at(4) });
    h.store.addresses[0].lastReceivedAt = at(5);
    expect((await admin.checkNewsletterTestMail({ since: startedAt, marker })).arrived).toBe(false);
    expect(h.poller.pollInboundSourceNow).toHaveBeenCalledWith("src1");
    // Another user's article with the marker does not count either.
    h.db.article.rows.push({ userId: "bob", title: `x ${marker}`, createdAt: at(6) });
    expect((await admin.checkNewsletterTestMail({ since: startedAt, marker })).arrived).toBe(false);
    h.db.article.rows.push({ userId: "admin", title: `FeedFerret Testmail ${marker}`, createdAt: at(12) });
    expect(await admin.checkNewsletterTestMail({ since: startedAt, marker })).toMatchObject({ arrived: true, seconds: 12 });
    expect(await admin.checkNewsletterTestMail({ since: startedAt, marker: "nope" })).toMatchObject({ arrived: false });
  });

  it("asks for confirmation only when a DIFFERENT mailbox would change existing addresses (F5)", async () => {
    // No addresses yet: switching mailboxes freely.
    await admin.saveNewsletterImap({ email: "box@gmail.com", password: "p" });
    expect((await admin.saveNewsletterImap({ email: "first@gmail.com", password: "p" })).ok).toBe(true);
    expect((await admin.saveNewsletterImap({ email: "box@gmail.com", password: "p" })).ok).toBe(true);

    as("bob");
    await user.getMyNewsletterInbox(); // bob now has an address
    as("admin");
    h.poller.testImapConnection.mockClear();
    expect(await admin.saveNewsletterImap({ email: "other@gmail.com", password: "p2" })).toMatchObject({ ok: false, code: "confirm-address-change" });
    expect(h.poller.testImapConnection).not.toHaveBeenCalled();
    expect(h.store.source!.address).toBe("box@gmail.com");
    // Same mailbox (e.g. new app password): no confirmation.
    expect((await admin.saveNewsletterImap({ email: "box@gmail.com", password: "p3" })).ok).toBe(true);

    // Disconnect needs confirm, wipes credentials, remembers only the mailbox.
    expect(await admin.disconnectNewsletterInbound()).toEqual({ ok: false, code: "confirm-required" });
    expect(h.store.source).not.toBeNull();
    expect(await admin.disconnectNewsletterInbound({ confirm: true })).toEqual({ ok: true });
    expect(h.store.source).toBeNull();
    expect(h.store.rows).toEqual([expect.objectContaining({ kind: "imap-disconnected", address: "box@gmail.com", credentials: null })]);
    expect((await admin.getNewsletterInboundState()).source).toBeNull();
    as("bob");
    expect((await user.getMyNewsletterInbox()).available).toBe(false);
    as("admin");

    // Reconnecting the SAME mailbox keeps every address: no confirmation.
    expect((await admin.saveNewsletterImap({ email: "box@gmail.com", password: "p" })).ok).toBe(true);
    expect(h.store.rows.map((r) => r.kind)).toEqual(["imap"]);
    expect(h.poller.testImapConnection).toHaveBeenCalled();

    // A different one after a disconnect does need it.
    await admin.disconnectNewsletterInbound({ confirm: true });
    expect(await admin.saveNewsletterImap({ email: "third@gmail.com", password: "p" })).toMatchObject({ ok: false, code: "confirm-address-change" });
    expect((await admin.saveNewsletterImap({ email: "third@gmail.com", password: "p", confirmAddressChange: true })).ok).toBe(true);
    expect(h.store.source!.address).toBe("third@gmail.com");
  });

  it("keeps the learned keywordsUnsupported while host and port stay the same (F4)", async () => {
    await admin.saveNewsletterImap({ email: "box@gmail.com", password: "p" });
    h.store.source!.settings = JSON.stringify({ ...JSON.parse(h.store.source!.settings), keywordsUnsupported: true });
    await admin.saveNewsletterImap({ email: "box@gmail.com", password: "new-pass" });
    expect(JSON.parse(h.store.source!.settings).keywordsUnsupported).toBe(true);
    await admin.saveNewsletterImap({ email: "box@gmail.com", password: "p", host: "imap.other.example", port: 993 });
    expect(JSON.parse(h.store.source!.settings).keywordsUnsupported).toBeUndefined();
  });

  it("pauses, resumes (clearing backoff) and disconnects", async () => {
    await admin.saveNewsletterImap({ email: "box@gmail.com", password: "p" });
    expect((await admin.setNewsletterInboundPaused({ paused: true })).source?.paused).toBe(true);
    h.store.source!.errorCount = 5;
    const resumed = await admin.setNewsletterInboundPaused({ paused: false });
    expect(resumed.source).toMatchObject({ paused: false, errorCount: 0 });
    expect(await admin.setNewsletterInboundPaused({ paused: "yes" })).toEqual({ ok: false });
    expect(await admin.disconnectNewsletterInbound({ confirm: true })).toEqual({ ok: true });
    expect(h.store.source).toBeNull();
  });
});

describe("webhook ways (Cloudflare / Postmark / Mailgun)", () => {
  const save = (over: Record<string, unknown> = {}) => admin.saveNewsletterDomainSource({ kind: "cloudflare", domain: "News.Example.org", ...over });

  it("stores the normalized domain and a sealed secret, and returns the secret exactly once", async () => {
    const res = await save({ paused: true, errorCount: 9, credentials: "evil" });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.secret).toMatch(/^[0-9a-f]{64}$/);
    const data = h.db.inboundMailSource.create.mock.calls[0][0].data;
    expect(data).toMatchObject({ kind: "cloudflare", address: "news.example.org", credentials: null, paused: false, errorCount: 0 });
    expect(data.webhookSecret).not.toContain(res.secret);
    expect(Buffer.from(data.webhookSecret.slice(4), "base64").toString()).toBe(res.secret);
    expect(res.source).toMatchObject({ kind: "cloudflare", address: "news.example.org", hasSecret: true, hasPassword: false, server: null, webhookPath: "/api/webhooks/inbound-email/src1" });
    // Neither the view nor a later state read carries the secret or its sealed form.
    for (const text of [JSON.stringify(res.source), JSON.stringify(await admin.getNewsletterInboundState())]) {
      expect(text).not.toContain(res.secret);
      expect(text).not.toContain(data.webhookSecret);
    }
  });

  it("validates way and domain", async () => {
    expect(await save({ kind: "imap" })).toEqual({ ok: false, code: "invalid-way" });
    expect(await save({ kind: undefined })).toEqual({ ok: false, code: "invalid-way" });
    for (const domain of ["", "localhost", "a@b.example", "https://news.example.org", "192.168.0.1", "-bad.example", "news.example.org/path", "x".repeat(300) + ".org", 42]) {
      expect(await save({ domain })).toEqual({ ok: false, code: "invalid-domain" });
    }
    expect((await save({ domain: "@news.example.org" })).ok).toBe(true);
    expect(h.db.inboundMailSource.create).toHaveBeenCalledTimes(1);
  });

  it("gives users <token>@domain addresses and the admin a test address on it", async () => {
    await save();
    as("bob");
    const inbox = await user.getMyNewsletterInbox();
    expect(inbox.available).toBe(true);
    expect(inbox.addresses[0].address).toMatch(/^[a-z2-7]{26}@news\.example\.org$/);
    as("admin");
    const test = (await admin.startNewsletterTest({})) as { address: string; marker: string; startedAt: string };
    expect(test.address).toMatch(/^[a-z2-7]{26}@news\.example\.org$/);
    // Webhook mail is pushed: checking never polls a mailbox.
    h.db.article.rows.push({ userId: "admin", title: `Testmail ${test.marker}`, createdAt: new Date(Date.now() + 1000) });
    expect((await admin.checkNewsletterTestMail({ since: test.startedAt, marker: test.marker })).arrived).toBe(true);
    expect(h.poller.pollInboundSourceNow).not.toHaveBeenCalled();
  });

  it("setting up again rotates the secret; a different domain or way asks for confirmation once addresses exist", async () => {
    const first = (await save()) as { ok: true; secret: string };
    const second = (await save()) as { ok: true; secret: string };
    expect(second.secret).not.toBe(first.secret);
    expect(h.store.rows).toHaveLength(1);
    expect(h.db.inboundMailSource.create).toHaveBeenCalledTimes(1);

    as("bob");
    await user.getMyNewsletterInbox();
    as("admin");
    expect(await save({ domain: "mail.example.org" })).toEqual({ ok: false, code: "confirm-address-change" });
    expect(h.store.rows[0].address).toBe("news.example.org");
    // Same domain, other webhook flavour: addresses stay.
    expect((await save({ kind: "webhook" })).ok).toBe(true);
    expect(h.store.rows[0].kind).toBe("webhook");
    expect((await save({ domain: "mail.example.org", confirmAddressChange: true })).ok).toBe(true);
    expect(h.store.rows[0].address).toBe("mail.example.org");

    // Back to a mailbox: plus-addresses replace <token>@domain.
    expect(await admin.saveNewsletterImap({ email: "box@gmail.com", password: "p" })).toMatchObject({ ok: false, code: "confirm-address-change" });
    const imap = await admin.saveNewsletterImap({ email: "box@gmail.com", password: "p", confirmAddressChange: true });
    expect(imap.ok).toBe(true);
    expect(h.store.rows).toHaveLength(1);
    expect(h.store.rows[0]).toMatchObject({ kind: "imap", webhookSecret: null });
    expect(await save()).toEqual({ ok: false, code: "confirm-address-change" });
  });

  it("rotating the secret of a paused source keeps it paused; a new way starts active", async () => {
    await save();
    await admin.setNewsletterInboundPaused({ paused: true });
    const rotated = await save();
    expect(rotated.ok && rotated.source.paused).toBe(true);
    expect(h.store.rows[0].paused).toBe(true);
    // Another way (webhook instead of cloudflare) is a fresh setup.
    const other = await save({ kind: "webhook" });
    expect(other.ok && other.source.paused).toBe(false);
  });

  it("pauses and disconnects like a mailbox: secret wiped, reconnecting the same domain keeps addresses", async () => {
    await save();
    expect((await admin.setNewsletterInboundPaused({ paused: true })).source?.paused).toBe(true);
    as("bob");
    await user.getMyNewsletterInbox();
    as("admin");
    expect(await admin.disconnectNewsletterInbound({ confirm: true })).toEqual({ ok: true });
    expect(h.store.rows).toEqual([expect.objectContaining({ kind: "cloudflare-disconnected", address: "news.example.org", webhookSecret: null, credentials: null })]);
    expect((await admin.getNewsletterInboundState()).source).toBeNull();
    as("bob");
    expect((await user.getMyNewsletterInbox()).available).toBe(false);
    as("admin");

    expect((await save()).ok).toBe(true);
    expect(h.store.rows.map((r) => r.kind)).toEqual(["cloudflare"]);
    await admin.disconnectNewsletterInbound({ confirm: true });
    expect(await save({ domain: "other.example.org" })).toEqual({ ok: false, code: "confirm-address-change" });
  });
});

describe("user newsletter actions", () => {
  it("explains instead of handing out addresses while no inbox is set up", async () => {
    as("bob");
    expect(await user.getMyNewsletterInbox()).toMatchObject({ available: false, isAdmin: false, addresses: [] });
    expect(await user.createMyNewsletterAddress({})).toEqual({ ok: false, error: "unavailable" });
    expect(h.store.addresses).toHaveLength(0);
  });

  it("gives every user a primary address and extra labelled ones", async () => {
    await admin.saveNewsletterImap({ email: "box@gmail.com", password: "p" });
    as("bob");
    const inbox = await user.getMyNewsletterInbox();
    expect(inbox.available).toBe(true);
    expect(inbox.addresses).toHaveLength(1);
    expect(inbox.addresses[0]).toMatchObject({ isPrimary: true, isActive: true });
    expect(inbox.addresses[0].address).toMatch(/^box\+ff-[a-z2-7]{26}@gmail\.com$/);
    const created = await user.createMyNewsletterAddress({ description: "  Substack   weekly ", userId: "eve", token: "x".repeat(26) });
    expect(created.ok).toBe(true);
    const extra = h.store.addresses.at(-1)!;
    expect(extra).toMatchObject({ userId: "bob", description: "Substack weekly" });
    expect(extra.token).not.toBe("x".repeat(26));
  });

  it("only touches the caller's own addresses and keeps one active", async () => {
    await admin.saveNewsletterImap({ email: "box@gmail.com", password: "p" });
    as("eve");
    const eveAddr = (await user.getMyNewsletterInbox()).addresses[0];
    as("bob");
    const bobInbox = await user.getMyNewsletterInbox();
    expect(await user.setMyNewsletterAddressActive({ id: eveAddr.id, active: false })).toMatchObject({ ok: false });
    expect(h.store.addresses.find((a) => a.id === eveAddr.id)?.isActive).toBe(true);
    expect(await user.setMyNewsletterAddressActive({ id: bobInbox.addresses[0].id, active: false })).toMatchObject({ ok: false, error: "last-active" });
    await user.createMyNewsletterAddress({});
    expect((await user.setMyNewsletterAddressActive({ id: bobInbox.addresses[0].id, active: false })).ok).toBe(true);
  });

  it("caps the number of addresses", async () => {
    await admin.saveNewsletterImap({ email: "box@gmail.com", password: "p" });
    as("bob");
    for (let i = 0; i < 30; i++) await user.createMyNewsletterAddress({});
    expect(h.store.addresses.filter((a) => a.userId === "bob").length).toBe(25);
    expect(await user.createMyNewsletterAddress({})).toEqual({ ok: false, error: "limit" });
  });

  it("first-address creation is idempotent under concurrent first loads", async () => {
    await admin.saveNewsletterImap({ email: "box@gmail.com", password: "p" });
    as("bob");
    const [a, b] = await Promise.all([user.getMyNewsletterInbox(), user.getMyNewsletterInbox()]);
    expect(h.store.addresses.filter((x) => x.userId === "bob")).toHaveLength(1);
    expect(a.addresses[0].address).toBe(b.addresses[0].address);
    expect(h.store.addresses.find((x) => x.userId === "bob")?.id).toBe("nl-primary-bob");
  });

  it("hides the settings section for non-admins until an inbox exists", async () => {
    const { isNewsletterSectionVisible } = await import("@/lib/newsletter-addresses");
    expect(await isNewsletterSectionVisible(true)).toBe(true);
    expect(await isNewsletterSectionVisible(false)).toBe(false);
    await admin.saveNewsletterImap({ email: "box@gmail.com", password: "p" });
    expect(await isNewsletterSectionVisible(false)).toBe(true);
  });

  it("requires a session", async () => {
    as(null);
    await expect(user.getMyNewsletterInbox()).rejects.toThrow(/Unauthorized/);
    await expect(user.setMyNewsletterAddressActive({ id: "x", active: false })).rejects.toThrow(/Unauthorized/);
  });
});
