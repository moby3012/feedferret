import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import bcrypt from "bcryptjs";
const state = vi.hoisted(() => ({ url: "", session: "u" }));
vi.mock("@/lib/db", async () => {
  const { PrismaClient } = await import("@prisma/client");
  const { PrismaBetterSqlite3 } = await import("@prisma/adapter-better-sqlite3");
  const { withExternalIds } = await import("@/lib/external-id-store");
  state.url = `file:${join(mkdtempSync(join(tmpdir(), "greader-management-")), "test.db")}`;
  return { db: withExternalIds(new PrismaClient({ adapter: new PrismaBetterSqlite3({ url: state.url }) })) };
});
vi.mock("@/auth", () => ({ auth: async () => state.session ? { user: { id: state.session } } : null }));
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
const password = "separate-api-password";
let auth = "";
const loginRequest = (pw: string) => login(new Request("http://localhost/api/greader.php/accounts/ClientLogin", { method: "POST", body: new URLSearchParams({ Email: "u@example.org", Passwd: pw }) }));
async function configure(extra = {}) {
  return settings(new Request("http://localhost/api/user/api-password", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ password, required: true, ...extra }) }));
}
async function call(path: string, entries?: [string, string][] | string, authorization = auth) {
  const init = entries === undefined ? {} : { method: "POST", body: typeof entries === "string" ? entries : new URLSearchParams(entries) };
  return (entries === undefined ? GET : POST)(new Request(`http://localhost/api/greader.php/reader/api/0/${path}`, { ...init, headers: { Authorization: authorization } }), { params: Promise.resolve({ path: ["reader", "api", "0", ...path.split("/")] }) });
}
beforeAll(() => {
  process.env.AUTH_SECRET = "contract-secret";
  execFileSync("node_modules/.bin/prisma", ["db", "push"], { env: { ...process.env, DATABASE_URL: state.url }, stdio: "pipe" });
}, 30000);
beforeEach(async () => {
  await db.user.deleteMany();
  state.session = "u";
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
    expect((await call("subscription/quickadd", [["quickadd", "https://example.org"]])).status).toBe(400);
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
    expect((await configure({ password: "replacement-api-password" })).status).toBe(200);
    expect((await call("tag/list")).status).toBe(401);
    auth = `GoogleLogin auth=${(await (await loginRequest("replacement-api-password")).text()).match(/Auth=(.+)/)![1]}`;
    expect((await call("disable-tag", [["s", "user/-/label/unused"], ["T", token]])).status).toBe(401);
    await configure({ revoke: true });
    expect((await call("tag/list")).status).toBe(401);
    expect((await loginRequest("replacement-api-password")).status).toBe(403);
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
