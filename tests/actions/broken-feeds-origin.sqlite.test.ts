// Repair must never carry one site's credentials to another origin. Real fetch path (no fetcher mock) against two
// local servers (= two origins) that record the request headers they receive.
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { PrismaClient } from "@prisma/client";
import { PrismaBetterSqlite3 } from "@prisma/adapter-better-sqlite3";

const h = vi.hoisted(() => ({ db: null as unknown as PrismaClient, userId: "" }));
vi.mock("@/lib/db", () => ({
  get db() {
    return h.db;
  },
  getDatabaseProvider: () => "sqlite",
}));
vi.mock("@/auth", () => ({ auth: vi.fn(async () => ({ user: { id: h.userId } })) }));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));

import { applyFeedRepair } from "../../app/actions/broken-feeds";
import { credentialResetForUrlChange } from "../../lib/feed-secrets";

type Seen = { path: string; headers: http.IncomingHttpHeaders };
const seen: Seen[] = [];
const servers: http.Server[] = [];
const RSS = `<?xml version="1.0"?><rss version="2.0"><channel><title>T</title><link>http://x</link><description>d</description><item><title>i</title><guid>g1</guid><link>http://x/i</link><description>d</description></item></channel></rss>`;
function listen(): Promise<string> {
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      seen.push({ path: req.url ?? "", headers: req.headers });
      res.writeHead(200, { "content-type": "application/rss+xml" }).end(RSS);
    });
    servers.push(server);
    server.listen(0, "127.0.0.1", () => resolve(`http://127.0.0.1:${(server.address() as AddressInfo).port}`));
  });
}

const dir = mkdtempSync(join(tmpdir(), "feedferret-origin-"));
let oldOrigin = "";
let newOrigin = "";
const OPTIONS = JSON.stringify({
  CURLOPT_HTTPHEADER: "X-Api-Token: old-site-secret",
  CURLOPT_COOKIE: "session=old-site-cookie",
  CURLOPT_USERAGENT: "MyAgent/1",
});
// A proxy is a per-origin secret too (credentials in the URL): cleared on an origin change.
const OPTIONS_WITH_PROXY = JSON.stringify({ ...JSON.parse(OPTIONS), CURLOPT_PROXY: "http://user:pw@proxy.invalid:3128" });

beforeAll(async () => {
  process.env.TRUSTED_FEED_FETCHING = "1"; // the test servers are on 127.0.0.1
  [oldOrigin, newOrigin] = [await listen(), await listen()];
  const url = `file:${join(dir, "test.db")}`;
  execFileSync("pnpm", ["exec", "prisma", "db", "push", "--schema", "prisma/schema.generated.prisma"], {
    env: { ...process.env, DATABASE_PROVIDER: "sqlite", DATABASE_URL: url },
    stdio: "pipe",
  });
  h.db = new PrismaClient({ adapter: new PrismaBetterSqlite3({ url }) });
  h.userId = (await h.db.user.create({ data: { email: "o@test", name: "O" } })).id;
}, 120_000);

afterAll(async () => {
  delete process.env.TRUSTED_FEED_FETCHING;
  await h.db?.$disconnect();
  await Promise.all(servers.map((s) => new Promise((r) => s.close(r))));
  rmSync(dir, { recursive: true, force: true });
});

beforeEach(async () => {
  seen.length = 0;
  await h.db.feed.deleteMany({});
});

const makeAuthedFeed = (httpOptions = OPTIONS) =>
  h.db.feed.create({
    data: {
      userId: h.userId,
      name: "Authed",
      url: `${oldOrigin}/old.xml`,
      authType: "basic",
      authUsername: "old-user",
      authPassword: "old-pass",
      httpOptions,
      autoMuted: true,
      consecutiveFailureCount: 10,
    },
  });

describe("repair to another origin", () => {
  it("sends no Authorization / Cookie / custom header / proxy to the new host and clears them from the feed", async () => {
    const feed = await makeAuthedFeed(OPTIONS_WITH_PROXY);
    const result = await applyFeedRepair(feed.id, `${newOrigin}/new.xml`);
    expect(result).toMatchObject({ success: true, recovered: true });

    const toNew = seen.filter((s) => s.headers.host === new URL(newOrigin).host);
    expect(toNew.length).toBeGreaterThanOrEqual(2); // verification fetch + the sync
    for (const { headers } of toNew) {
      expect(headers.authorization).toBeUndefined();
      expect(headers.cookie).toBeUndefined();
      expect(headers["x-api-token"]).toBeUndefined();
    }
    expect(seen.some((s) => s.headers.host === new URL(oldOrigin).host)).toBe(false);

    const after = await h.db.feed.findUniqueOrThrow({ where: { id: feed.id } });
    expect(after).toMatchObject({ url: `${newOrigin}/new.xml`, authType: null, authUsername: null, authPassword: null });
    const kept = JSON.parse(after.httpOptions ?? "{}");
    expect(kept).toEqual({ CURLOPT_USERAGENT: "MyAgent/1" });
  });

  it("keeps auth and options when only the path changes (same origin) and still authenticates", async () => {
    const feed = await makeAuthedFeed();
    const result = await applyFeedRepair(feed.id, `${oldOrigin}/moved/new.xml`);
    expect(result).toMatchObject({ success: true });
    const toOld = seen.filter((s) => s.path === "/moved/new.xml");
    expect(toOld.length).toBeGreaterThanOrEqual(2);
    for (const { headers } of toOld) {
      expect(headers.authorization).toBe(`Basic ${Buffer.from("old-user:old-pass").toString("base64")}`);
      expect(headers.cookie).toBe("session=old-site-cookie");
      expect(headers["x-api-token"]).toBe("old-site-secret");
    }
    const after = await h.db.feed.findUniqueOrThrow({ where: { id: feed.id } });
    expect(after).toMatchObject({ authType: "basic", authUsername: "old-user", authPassword: "old-pass", httpOptions: OPTIONS });
  });
});

describe("credentialResetForUrlChange", () => {
  it("treats scheme, host and port as the origin", () => {
    const same = credentialResetForUrlChange("https://a.example/x", "https://a.example:443/y", OPTIONS);
    expect(same).toEqual({});
    for (const next of ["http://a.example/x", "https://b.example/x", "https://a.example:8443/x", "https://sub.a.example/x", "not a url"]) {
      expect(credentialResetForUrlChange("https://a.example/x", next, OPTIONS)).toMatchObject({ authType: null, authUsername: null, authPassword: null });
    }
    expect(credentialResetForUrlChange("not a url", "https://a.example/x", OPTIONS)).toMatchObject({ authPassword: null });
  });

  it("keeps only public fetch options", () => {
    expect(JSON.parse(credentialResetForUrlChange("https://a.example", "https://b.example", OPTIONS_WITH_PROXY).httpOptions!)).toEqual({ CURLOPT_USERAGENT: "MyAgent/1" });
    expect(credentialResetForUrlChange("https://a.example", "https://b.example", JSON.stringify({ CURLOPT_COOKIE: "x" })).httpOptions).toBeNull();
    expect(credentialResetForUrlChange("https://a.example", "https://b.example", null).httpOptions).toBeNull();
  });
});
