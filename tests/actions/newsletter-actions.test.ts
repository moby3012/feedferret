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
    source: null as null | Record<string, unknown>,
    addresses: [] as Address[],
    seq: 0,
  };
  const pick = (row: Record<string, unknown>, select?: Record<string, boolean>) =>
    select ? Object.fromEntries(Object.keys(select).map((k) => [k, row[k]])) : row;
  const addrMatch = (a: Address, where: any) =>
    (where.userId === undefined || a.userId === where.userId) &&
    (where.isActive === undefined || a.isActive === where.isActive) &&
    (where.id === undefined || (typeof where.id === "string" ? a.id === where.id : a.id !== where.id.not)) &&
    (where.token?.in === undefined || where.token.in.includes(a.token));
  const db = {
    user: { findUnique: vi.fn(async ({ where }: any) => store.users[where.id] ?? null) },
    globalSettings: { findUnique: vi.fn(async () => ({ require2FAForAdmins: false })) },
    adminAuditLog: { create: vi.fn(async () => ({})) },
    inboundMailSource: {
      findFirst: vi.fn(async ({ select }: any) => (store.source ? pick(store.source, select) : null)),
      findMany: vi.fn(async () => (store.source ? [store.source] : [])),
      create: vi.fn(async ({ data, select }: any) => {
        store.source = { id: "src1", createdAt: new Date(), lastReceivedAt: null, lastCheckedAt: null, ...data };
        return pick(store.source!, select);
      }),
      update: vi.fn(async ({ data, select }: any) => {
        store.source = { ...store.source!, ...data };
        return pick(store.source!, select);
      }),
      delete: vi.fn(async () => {
        store.source = null;
        return {};
      }),
    },
    newsletterAddress: {
      findFirst: vi.fn(async ({ where }: any) => store.addresses.find((a) => addrMatch(a, where)) ?? null),
      findMany: vi.fn(async ({ where }: any) => store.addresses.filter((a) => addrMatch(a, where))),
      findUnique: vi.fn(async ({ where }: any) => store.addresses.find((a) => a.id === where.id) ?? null),
      count: vi.fn(async ({ where }: any) => store.addresses.filter((a) => addrMatch(a, where)).length),
      create: vi.fn(async ({ data }: any) => {
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
  h.store.users.admin.role = "ADMIN";
  as("admin");
});

describe("admin wizard actions", () => {
  const calls: [string, () => Promise<unknown>][] = [
    ["getNewsletterInboundState", () => admin.getNewsletterInboundState()],
    ["detectNewsletterImapServer", () => admin.detectNewsletterImapServer({ email: "a@gmail.com" })],
    ["testNewsletterImap", () => admin.testNewsletterImap({ email: "a@gmail.com", password: "x" })],
    ["saveNewsletterImap", () => admin.saveNewsletterImap({ email: "a@gmail.com", password: "x" })],
    ["sendNewsletterTestMail", () => admin.sendNewsletterTestMail()],
    ["checkNewsletterTestMail", () => admin.checkNewsletterTestMail({ since: new Date().toISOString() })],
    ["setNewsletterInboundPaused", () => admin.setNewsletterInboundPaused({ paused: true })],
    ["disconnectNewsletterInbound", () => admin.disconnectNewsletterInbound()],
  ];

  it.each(calls)("%s rejects non-admins and anonymous callers", async (_name, call) => {
    as("bob");
    await expect(call()).rejects.toThrow(/Unauthorized/);
    as(null);
    await expect(call()).rejects.toThrow(/Unauthorized/);
    expect(h.db.inboundMailSource.create).not.toHaveBeenCalled();
    expect(h.db.inboundMailSource.update).not.toHaveBeenCalled();
    expect(h.db.inboundMailSource.delete).not.toHaveBeenCalled();
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

  it("without a mailer the test step hands out the admin's own address", async () => {
    await admin.saveNewsletterImap({ email: "box@gmail.com", password: "p" });
    const res = await admin.sendNewsletterTestMail();
    expect(res).toMatchObject({ ok: true, sent: false });
    expect((res as { address: string }).address).toMatch(/^box\+ff-[a-z2-7]{26}@gmail\.com$/);
    expect(h.store.addresses.every((a) => a.userId === "admin")).toBe(true);
  });

  it("reports arrival once the admin's address received mail after `since`", async () => {
    await admin.saveNewsletterImap({ email: "box@gmail.com", password: "p" });
    const { startedAt } = (await admin.sendNewsletterTestMail()) as { startedAt: string };
    expect((await admin.checkNewsletterTestMail({ since: startedAt })).arrived).toBe(false);
    expect(h.poller.pollInboundSourceNow).toHaveBeenCalledWith("src1");
    h.store.addresses[0].lastReceivedAt = new Date(new Date(startedAt).getTime() + 12_000);
    expect(await admin.checkNewsletterTestMail({ since: startedAt })).toMatchObject({ arrived: true, seconds: 12 });
  });

  it("pauses, resumes (clearing backoff) and disconnects", async () => {
    await admin.saveNewsletterImap({ email: "box@gmail.com", password: "p" });
    expect((await admin.setNewsletterInboundPaused({ paused: true })).source?.paused).toBe(true);
    h.store.source!.errorCount = 5;
    const resumed = await admin.setNewsletterInboundPaused({ paused: false });
    expect(resumed.source).toMatchObject({ paused: false, errorCount: 0 });
    expect(await admin.setNewsletterInboundPaused({ paused: "yes" })).toEqual({ ok: false });
    expect(await admin.disconnectNewsletterInbound()).toEqual({ ok: true });
    expect(h.store.source).toBeNull();
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

  it("requires a session", async () => {
    as(null);
    await expect(user.getMyNewsletterInbox()).rejects.toThrow(/Unauthorized/);
    await expect(user.setMyNewsletterAddressActive({ id: "x", active: false })).rejects.toThrow(/Unauthorized/);
  });
});
