import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import bcrypt from "bcryptjs";
const state = vi.hoisted(() => ({ url: "", session: "u", authenticatedAt: undefined as number | undefined }));
vi.mock("@/lib/db", async () => {
  const { PrismaClient } = await import("@prisma/client");
  const { PrismaBetterSqlite3 } = await import("@prisma/adapter-better-sqlite3");
  const { withExternalIds } = await import("@/lib/external-id-store");
  state.url = `file:${join(mkdtempSync(join(tmpdir(), "greader-management-")), "test.db")}`;
  return { getDatabaseProvider: () => "sqlite", db: withExternalIds(new PrismaClient({ adapter: new PrismaBetterSqlite3({ url: state.url }) })) };
});
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("next-intl/server", () => ({ getTranslations: async () => (key: string) => key }));
vi.mock("@/auth", () => ({ auth: async () => state.session ? { user: { id: state.session }, authenticatedAt: state.authenticatedAt } : null }));
vi.mock("@/lib/rss-sync", () => ({ syncFeed: vi.fn() }));
vi.mock("@/lib/feed-fetcher", () => ({ fetchFeedArticles: vi.fn(async () => ({ title: "Discovered" })) }));
vi.mock("@/lib/feed-discovery", () => ({ discoverFeeds: vi.fn(async () => ({ feeds: [{ url: "https://example.org/rss" }] })) }));
vi.mock("dns/promises", () => ({ default: { lookup: async () => [{ address: "93.184.216.34", family: 4 }] } }));
import { discoverFeeds } from "@/lib/feed-discovery";
import { db } from "@/lib/db";
import { POST as login } from "@/app/api/greader.php/accounts/ClientLogin/route";
import { GET, POST } from "@/app/api/greader.php/[...path]/route";
import { GET as probe } from "@/app/api/greader.php/route";
import { POST as settings } from "@/app/api/user/api-password/route";
import { POST as fever } from "@/app/api/fever.php/route";
import { hashApiToken, generateFeverKey } from "@/lib/token";
const password = "separate-api-password-long-secret";
let auth = "";
const loginRequest = (pw: string) => login(new Request("http://localhost/api/greader.php/accounts/ClientLogin", { method: "POST", body: new URLSearchParams({ Email: "u@example.org", Passwd: pw }) }));
async function configure(extra = {}) {
  return settings(new Request("http://localhost/api/user/api-password", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ password, currentPassword: "login-password", required: true, ...extra }) }));
}
async function call(path: string, entries?: [string, string][] | string, authorization = auth) {
  const init = entries === undefined ? {} : { method: "POST", body: typeof entries === "string" ? entries : new URLSearchParams(entries) };
  return (entries === undefined ? GET : POST)(new Request(`http://localhost/api/greader.php/reader/api/0/${path}`, { ...init, headers: { Authorization: authorization } }), { params: Promise.resolve({ path: ["reader", "api", "0", ...path.split("?")[0].split("/")] }) });
}
beforeAll(() => {
  process.env.AUTH_SECRET = "contract-secret";
  execFileSync("node_modules/.bin/prisma", ["db", "push"], { env: { ...process.env, DATABASE_URL: state.url }, stdio: "pipe" });
}, 30000);
let clock = Date.now();
beforeEach(async () => {
  clock += 3600_001;
  vi.spyOn(Date, "now").mockReturnValue(clock);
  await db.user.deleteMany();
  state.session = "u";
  state.authenticatedAt = undefined;
  await db.user.create({ data: { id: "u", email: "u@example.org", password: await bcrypt.hash("login-password", 4) } });
  await db.user.create({ data: { id: "other" } });
  const response = await loginRequest("login-password");
  auth = `GoogleLogin auth=${(await response.text()).match(/Auth=(.+)/)![1]}`;
});
afterAll(async () => { await db.$disconnect(); rmSync(join(state.url.slice(5), ".."), { recursive: true, force: true }); });
describe("FreshRSS management contracts on SQLite", () => {
  it("preserves alias probe, form body, unicode and repeated subscriptions; moves folders atomically per feed", async () => {
    expect(await probe().text()).toBe("OK");
    const cat = await db.category.create({ data: { userId: "u", name: "Old" } });
    for (const url of ["https://example.org/1", "https://example.org/2"]) await db.feed.create({ data: { userId: "u", name: "Old", url, categoryId: cat.id } });
    expect((await call("subscription/edit", [["s", "feed/https://example.org/1"], ["s", "feed/https://example.org/2"], ["ac", "edit"], ["a", "user/-/label/日本語/ニュース"], ["r", "user/-/label/Old"], ["t", "Ünicode"]])).status).toBe(200);
    const feeds = await db.feed.findMany({ where: { userId: "u" }, include: { category: true } });
    expect(feeds.map((f) => [f.name, f.category?.name])).toEqual([["Ünicode", "日本語/ニュース"], ["Ünicode", "日本語/ニュース"]]);
    const response = await call("subscription/export");
    expect(await response.text()).toContain("日本語/ニュース");
  });
  it("uses the shared OPML core for raw imports and exports only owned feeds", async () => {
    const xml = '<?xml version="1.0"?><opml version="2.0"><body><outline text="科学"><outline text="News" type="rss" xmlUrl="https://example.org/rss"/></outline></body></opml>';
    expect((await call("subscription/import", xml)).status).toBe(200);
    expect(await db.feed.count({ where: { userId: "u" } })).toBe(1);
    expect((await call("subscription/import", "<!DOCTYPE x [<!ENTITY a 'x'>]><opml/>" )).status).toBe(400);
    expect(await (await call("subscription/export")).text()).toContain("科学");
  });
  it("retains FreshRSS scraper extensions through both OPML URL bases", async () => {
    const xml = readFileSync(join(__dirname, "../fixtures/freshrss/feeds_2026-11-09.opml.xml"), "utf8");
    expect((await call("subscription/import", xml)).status).toBe(200);
    const feed = await db.feed.findFirstOrThrow({ where: { userId: "u", name: "Ars Technica" } });
    expect(feed.fullTextSelector).toBe("article .article-content");
    const { GET: canonical } = await import("@/app/api/greader/[...path]/route");
    const response = await canonical(new Request("http://localhost/api/greader/reader/api/0/subscription/export", { headers: { Authorization: auth } }), { params: Promise.resolve({ path: ["reader", "api", "0", "subscription", "export"] }) });
    expect(response.headers.get("content-type")).toContain("opml");
    expect(await response.text()).toContain('cssFullContent="article .article-content"');
  });
  it("rejects unsafe discovered feed URLs before creating subscriptions", async () => {
    vi.mocked(discoverFeeds).mockResolvedValueOnce({ mode: "url", feeds: [{ url: "http://127.0.0.1/private", title: "Blocked", type: "rss" }] });
    expect(await (await call("subscription/quickadd", [["quickadd", "https://example.org"]])).json()).toMatchObject({ numResults: 0, error: expect.any(String) });
    expect(await db.feed.count()).toBe(0);
  });
  it("reports folder/tag types, rejects destination collisions and deletes namesakes without deleting articles", async () => {
    const category = await db.category.create({ data: { userId: "u", name: "Both" } });
    await db.label.create({ data: { userId: "u", name: "Both" } });
    await db.label.create({ data: { userId: "u", name: "Tag" } });
    const feed = await db.feed.create({ data: { userId: "u", categoryId: category.id, name: "Feed", url: "https://example.org/rss" } });
    await db.article.create({ data: { userId: "u", feedId: feed.id, title: "Keep", content: "Body", link: "https://example.org/a", publishedAt: new Date() } });
    const tags = (await (await call("tag/list")).json()).tags;
    expect(tags).toContainEqual(expect.objectContaining({ id: "user/-/label/Both", type: "folder" }));
    expect(tags).toContainEqual(expect.objectContaining({ id: "user/-/label/Tag", type: "tag" }));
    expect((await call("rename-tag", [["s", "user/-/label/Both"], ["dest", "user/-/label/Tag"]])).status).toBe(409);
    expect((await call("rename-tag", [["s", "user/-/label/Both"], ["dest", "user/-/label/新"]])).status).toBe(200);
    expect((await call("disable-tag", [["s", "user/-/label/新"]])).status).toBe(200);
    expect(await db.article.count()).toBe(1);
    expect((await db.feed.findUniqueOrThrow({ where: { id: feed.id } })).categoryId).toBeNull();
  });
  it.each([false, true])("API password works with 2FA=%s, invalidates Auth/T, and revocation keeps login fallback disabled", async (twoFactorEnabled) => {
    await db.user.update({ where: { id: "u" }, data: { twoFactorEnabled } });
    expect((await loginRequest("login-password")).status).toBe(twoFactorEnabled ? 403 : 200);
    expect((await configure()).status).toBe(200);
    expect((await call("tag/list")).status).toBe(401);
    expect((await loginRequest("login-password")).status).toBe(403);
    const token = (await (await loginRequest(password)).text()).match(/Auth=(.+)/)![1];
    auth = `GoogleLogin auth=${token}`;
    expect((await call("tag/list")).status).toBe(200);
    expect((await call("tag/list", undefined, `Basic ${Buffer.from(`u@example.org:${password}`).toString("base64")}`)).status).toBe(200);
    const feverResponse = await fever(new Request("http://localhost/api/fever.php?api", { method: "POST", body: new URLSearchParams({ api_key: generateFeverKey("u@example.org", password) }) }));
    expect((await feverResponse.json()).auth).toBe(1);
    expect((await configure({ password: "replacement-api-password-long-secret" })).status).toBe(200);
    expect((await call("tag/list")).status).toBe(401);
    auth = `GoogleLogin auth=${(await (await loginRequest("replacement-api-password-long-secret")).text()).match(/Auth=(.+)/)![1]}`;
    expect((await call("disable-tag", [["s", "user/-/label/unused"], ["T", token]])).status).toBe(401);
    await configure({ revoke: true });
    expect((await call("tag/list")).status).toBe(401);
    expect((await loginRequest("replacement-api-password-long-secret")).status).toBe(403);
    expect((await loginRequest("login-password")).status).toBe(403);
  });
  it("requires an active first-party session and blocks cross-site credential changes", async () => {
    state.session = ""; expect((await configure()).status).toBe(401);
    state.session = "u";
    expect((await settings(new Request("http://localhost/api/user/api-password", { method: "POST", headers: { origin: "https://evil.test" } }))).status).toBe(403);
    await db.user.update({ where: { id: "u" }, data: { isActive: false, apiTokenVersion: { increment: 1 } } });
    expect((await call("tag/list")).status).toBe(401);
    await db.user.update({ where: { id: "u" }, data: { isActive: true } });
    expect((await call("tag/list")).status).toBe(401);
  });
  it("enforces bearer write scopes and user ownership and bounds bodies", async () => {
    await db.apiToken.create({ data: { userId: "u", name: "read", tokenHash: hashApiToken("read-token"), scope: "read" } });
    expect((await call("tag/list", undefined, "Bearer read-token")).status).toBe(200);
    expect((await call("disable-tag", [["s", "user/-/label/Other"]], "Bearer read-token")).status).toBe(403);
    expect((await call("token", undefined, "Bearer read-token")).status).toBe(403);
    const other = await db.category.create({ data: { userId: "other", name: "Other" } });
    await call("disable-tag", [["s", "user/-/label/Other"]]);
    expect(await db.category.findUnique({ where: { id: other.id } })).not.toBeNull();
    expect((await call("subscription/edit", "s=" + "x".repeat(130 * 1024))).status).toBe(413);
  });
  it("quickadd resolves page URLs and batch subscribe applies the requested title", async () => {
    expect((await call("subscription/edit", [["ac", "subscribe"], ["s", "feed/https://example.org"], ["t", "Resolved"]])).status).toBe(200);
    expect((await db.feed.findFirstOrThrow({ where: { userId: "u" } })).name).toBe("Resolved");
    expect((await call("subscription/edit", [["ac", "unsubscribe"], ["s", "feed/https://example.org/rss"]])).status).toBe(200);
    expect(await db.feed.count()).toBe(0);
  });
});

async function feverAuth(secret: string, ip = "fever-test") {
  return fever(new Request("http://localhost/api/fever.php?api", { method: "POST", headers: { "x-forwarded-for": ip }, body: new URLSearchParams({ api_key: generateFeverKey("u@example.org", secret) }) }));
}
it("rejects old Fever keys after rotation/revocation and stores only key hashes", async () => {
  await configure();
  expect((await db.user.findUniqueOrThrow({ where: { id: "u" } })).apiFeverKey).toBe(hashApiToken(generateFeverKey("u@example.org", password)));
  await configure({ password: "replacement-api-password-long-secret" });
  expect((await (await feverAuth(password)).json()).auth).toBe(0);
  expect((await (await feverAuth("replacement-api-password-long-secret")).json()).auth).toBe(1);
  await configure({ revoke: true });
  expect((await (await feverAuth("replacement-api-password-long-secret")).json()).auth).toBe(0);
});
it("changes login password, retains API password, revokes Auth/T and invalidates cached verification", async () => {
  const { changePassword } = await import("@/app/actions/settings");
  await configure();
  auth = `GoogleLogin auth=${(await (await loginRequest(password)).text()).match(/Auth=(.+)/)![1]}`;
  const basic = `Basic ${Buffer.from(`u@example.org:${password}`).toString("base64")}`;
  expect((await call("tag/list", undefined, basic)).status).toBe(200);
  expect(await changePassword({ currentPassword: "login-password", newPassword: "new-login-password-123" })).toEqual({ success: true });
  expect((await call("tag/list")).status).toBe(401);
  expect((await call("tag/list", undefined, basic)).status).toBe(200);
  await configure({ currentPassword: "new-login-password-123", password: "rotated-api-password-123456" });
  expect((await call("tag/list", undefined, basic)).status).toBe(401);
});
it("requires step-up, rejects short chosen secrets, generates a secret and throttles attempts", async () => {
  expect((await configure({ currentPassword: "wrong" })).status).toBe(403);
  expect((await configure({ password: "short" })).status).toBe(400);
  const generated = await (await configure({ password: "" })).json();
  expect(generated.password.length).toBeGreaterThanOrEqual(24);
  for (let i = 0; i < 7; i++) await configure({ currentPassword: "wrong" });
  expect((await configure()).status).toBe(429);
});
it("shares Fever failures with Basic and stops before credential lookup", async () => {
  for (let i = 0; i < 10; i++) expect((await (await feverAuth("wrong", "shared-ip")).json()).auth).toBe(0);
  const lookup = vi.spyOn(db.user, "findUnique");
  const response = await GET(new Request("http://localhost/api/greader/tag/list", { headers: { "x-forwarded-for": "shared-ip", Authorization: `Basic ${Buffer.from("u@example.org:login-password").toString("base64")}` } }), { params: Promise.resolve({ path: ["tag", "list"] }) });
  expect(response.status).toBe(401);
  expect((await (await feverAuth("login-password", "shared-ip")).json()).auth).toBe(0);
  expect(lookup).not.toHaveBeenCalled(); lookup.mockRestore();
});
it("redacts both API OPML exports for read-scope bearer tokens", async () => {
  await db.apiToken.create({ data: { userId: "u", name: "read", tokenHash: hashApiToken("export-read"), scope: "read" } });
  await db.feed.create({ data: { userId: "u", name: "Public", url: "https://user:feed-password@example.org/rss", httpOptions: JSON.stringify({ CURLOPT_COOKIE: "cookie-secret", CURLOPT_HTTPHEADER: "header-secret", CURLOPT_POSTFIELDS: "post-secret", CURLOPT_PROXY: "http://user:proxy-password@proxy.org" }), scraperConfig: JSON.stringify({ extensions: { password: "extension-secret" } }), fullTextSelector: "article" } });
  const { GET: v1 } = await import("@/app/api/v1/[...path]/route");
  state.session = ""; // Exercise v1 bearer authentication rather than session fallback.
  const outputs = [await call("subscription/export", undefined, "Bearer export-read"), await v1(new Request("http://localhost/api/v1/opml", { headers: { Authorization: "Bearer export-read" } }), { params: Promise.resolve({ path: ["opml"] }) })];
  for (const response of outputs) {
    expect(response.status).toBe(200);
    const xml = await response.text();
    for (const secret of ["feed-password", "cookie-secret", "header-secret", "post-secret", "proxy-password", "extension-secret"]) expect(xml).not.toContain(secret);
    expect(xml).toContain('cssFullContent="article"');
  }
});
it.each([["a", 11], ["r", 11], ["s", 101]] as const)("bounds %s before mutation", async (key, count) => {
  expect((await call("edit-tag", Array.from({ length: count }, () => [key, "user/-/label/x"] as [string, string]))).status).toBe(400);
  expect(await db.label.count()).toBe(0);
});
it("caps imports before writes and limits to five imports per hour", async () => {
  const xml = '<opml version="2.0"><body>' + '<outline type="rss" text="a" xmlUrl="https://example.org/rss"/>'.repeat(2001) + '</body></opml>';
  expect((await call("subscription/import", xml)).status).toBe(400);
  expect(await db.feed.count()).toBe(0);
  for (let i = 0; i < 4; i++) await call("subscription/import", "<opml><body/></opml>");
  expect((await call("subscription/import", "<opml><body/></opml>")).status).toBe(429);
});
it("supports query streams, named-user labels, per-stream titles and quickadd streamName", async () => {
  const first = await db.feed.create({ data: { userId: "u", name: "first", url: "https://example.org/first" } });
  const second = await db.feed.create({ data: { userId: "u", name: "second", url: "https://example.org/second" } });
  expect((await call(`subscription/edit?s=feed/${first.extId}&s=feed/${second.extId}`, [["t", "One"], ["t", "Two"], ["a", "user/alice/label/Folder"]])).status).toBe(200);
  expect((await db.feed.findUniqueOrThrow({ where: { id: second.id } })).name).toBe("Two");
  expect(await (await call("subscription/quickadd", [["quickadd", `feed/https://example.org/first`]])).json()).toMatchObject({ numResults: 1, streamName: "One" });
});

it("throttles last-used writes, verifies Basic once per minute and reloads versions", async () => {
  await configure();
  const basic = `Basic ${Buffer.from(`u@example.org:${password}`).toString("base64")}`;
  const compare = vi.spyOn(bcrypt, "compare");
  const writes = vi.spyOn(db.user, "updateMany");
  for (let i = 0; i < 4; i++) expect((await call("tag/list", undefined, basic)).status).toBe(200);
  expect(compare).toHaveBeenCalledTimes(1);
  expect(writes).toHaveBeenCalledTimes(1);
  await feverAuth(password);
  expect(writes).toHaveBeenCalledTimes(1);
  vi.spyOn(Date, "now").mockReturnValue(clock + 61_000);
  expect((await call("tag/list", undefined, basic)).status).toBe(200);
  expect(compare).toHaveBeenCalledTimes(2);
  compare.mockRestore(); writes.mockRestore();
});
it("Fever observes Basic lockout before lookup", async () => {
  for (let i = 0; i < 10; i++) await GET(new Request("http://localhost/api/greader/tag/list", { headers: { "x-forwarded-for": "basic-fail-ip", Authorization: `Basic ${Buffer.from(`missing-${i}@example.org:wrong`).toString("base64")}` } }), { params: Promise.resolve({ path: ["tag", "list"] }) });
  const lookup = vi.spyOn(db.user, "findUnique");
  expect((await (await feverAuth(password, "basic-fail-ip")).json()).auth).toBe(0);
  expect(lookup).not.toHaveBeenCalled(); lookup.mockRestore();
});

it("allows an enabled TOTP for step-up and clears Fever keys when email changes", async () => {
  const { generateTotpToken } = await import("@/lib/totp");
  const { updateProfile } = await import("@/app/actions/settings");
  const secret = "JBSWY3DPEHPK3PXP";
  await db.user.update({ where: { id: "u" }, data: { twoFactorEnabled: true, twoFactorSecret: secret } });
  expect((await configure({ currentPassword: "", totp: generateTotpToken(secret) })).status).toBe(200);
  await db.apiToken.create({ data: { userId: "u", name: "Fever", tokenHash: "email-test", feverKey: hashApiToken("old-email-key") } });
  // N17: an email change needs its own step-up (the TOTP above is consumed).
  expect(await updateProfile({ email: "new@example.org" })).toEqual({ success: false, code: "stepUpRequired" });
  expect(await updateProfile({ email: "new@example.org", currentPassword: "login-password" })).toMatchObject({ success: true, emailChanged: true });
  expect((await db.user.findUniqueOrThrow({ where: { id: "u" } })).apiFeverKey).toBeNull();
  expect((await db.apiToken.findFirstOrThrow({ where: { userId: "u" } })).feverKey).toBeNull();
  expect((await (await feverAuth(password)).json()).auth).toBe(0);
});


it.each(["token", "password"])("migrates a legacy plaintext %s Fever key without consuming failure budget", async (kind) => {
  const key = generateFeverKey("u@example.org", password);
  if (kind === "token") await db.apiToken.create({ data: { userId: "u", name: "legacy", tokenHash: "legacy", feverKey: key } });
  else await db.user.update({ where: { id: "u" }, data: { apiPasswordHash: "hash", apiFeverKey: key } });
  for (let i = 0; i < 12; i++) expect((await (await feverAuth(password, "legacy-ip")).json()).auth).toBe(1);
  const stored = kind === "token" ? (await db.apiToken.findFirstOrThrow()).feverKey : (await db.user.findUniqueOrThrow({ where: { id: "u" } })).apiFeverKey;
  expect(stored).toBe(hashApiToken(key));
  const lookup = vi.spyOn(kind === "token" ? db.apiToken : db.user, kind === "token" ? "findFirst" : "findUnique");
  expect((await (await feverAuth(password, "legacy-ip")).json()).auth).toBe(1);
  expect(lookup.mock.calls.some(([args]) => JSON.stringify(args).includes(`"${key}"`))).toBe(false);
  lookup.mockRestore();
});
it("backfills plaintext Fever keys idempotently and preserves hashes and cleared keys", async () => {
  const { backfillFeverKeys } = await import("@/lib/fever-keys");
  const key = generateFeverKey("u@example.org", password);
  await db.user.update({ where: { id: "u" }, data: { apiFeverKey: key } });
  await db.apiToken.create({ data: { userId: "u", name: "legacy", tokenHash: "legacy", feverKey: key } });
  await db.apiToken.create({ data: { userId: "u", name: "cleared", tokenHash: "cleared", feverKey: null } });
  await backfillFeverKeys();
  expect((await db.user.findUniqueOrThrow({ where: { id: "u" } })).apiFeverKey).toBe(hashApiToken(key));
  expect((await db.apiToken.findFirstOrThrow({ where: { tokenHash: "legacy" } })).feverKey).toBe(hashApiToken(key));
  const userWrites = vi.spyOn(db.user, "updateMany");
  const tokenWrites = vi.spyOn(db.apiToken, "updateMany");
  await backfillFeverKeys();
  expect(userWrites).not.toHaveBeenCalled(); expect(tokenWrites).not.toHaveBeenCalled();
  expect((await db.apiToken.findFirstOrThrow({ where: { tokenHash: "cleared" } })).feverKey).toBeNull();
  userWrites.mockRestore(); tokenWrites.mockRestore();
});
it.each([undefined, -1, 601, 600, 0])("passwordless step-up checks actual sign-in age %s", async (age) => {
  await db.user.update({ where: { id: "u" }, data: { password: null } });
  state.authenticatedAt = age === undefined ? undefined : Date.now() / 1000 - age;
  const response = await configure({ currentPassword: "" });
  expect(response.status).toBe(age !== undefined && age >= 0 && age <= 600 ? 200 : 403);
  if (response.status === 403) expect(await response.json()).toMatchObject({ code: "reloginRequired" });
});
it("fresh sessions cannot bypass step-up for password or 2FA accounts", async () => {
  state.authenticatedAt = Date.now() / 1000;
  expect((await configure({ currentPassword: "" })).status).toBe(403);
  await db.user.update({ where: { id: "u" }, data: { password: null, twoFactorEnabled: true } });
  expect((await configure({ currentPassword: "" })).status).toBe(403);
});
it("rejects concurrent TOTP reuse across login and API-password step-up", async () => {
  const { consumeTotpToken } = await import("@/lib/totp-consume");
  const { generateTotpToken } = await import("@/lib/totp");
  const secret = "JBSWY3DPEHPK3PXP";
  await db.user.update({ where: { id: "u" }, data: { twoFactorEnabled: true, twoFactorSecret: secret } });
  const code = generateTotpToken(secret);
  const claims = await Promise.all([consumeTotpToken("u", secret, code), consumeTotpToken("u", secret, code)]);
  expect(claims.filter(Boolean)).toHaveLength(1);
  expect((await configure({ currentPassword: "", totp: code })).status).toBe(403);
  const next = generateTotpToken(secret, Date.now() + 30_000);
  expect((await configure({ currentPassword: "", totp: next })).status).toBe(200);
  expect(await consumeTotpToken("u", secret, next)).toBe(false);
});
