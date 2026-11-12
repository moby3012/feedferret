// Twitch API sources through the REAL syncFeed on a real SQLite DB; only the
// SSRF transport (Twitch HTTP) and secret decryption are faked.
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { PrismaClient } from "@prisma/client";
import { PrismaBetterSqlite3 } from "@prisma/adapter-better-sqlite3";

const state = vi.hoisted(() => ({ db: null as unknown as PrismaClient, tokenStatus: 200, streams: [] as unknown[] }));
vi.mock("@/lib/db", () => ({
  get db() { return state.db; },
  getDatabaseProvider: () => "sqlite",
}));
vi.mock("@/lib/crypto", async (importOriginal) => ({ ...(await importOriginal<typeof import("../../lib/crypto")>()), decryptIfValue: (v: string | null) => (v ? "synthetic-secret" : null) }));
vi.mock("@/lib/ssrf", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../lib/ssrf")>();
  const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });
  return {
    ...actual,
    safeFetch: vi.fn(async (url: string) =>
      url.includes("oauth2/token") ? json(state.tokenStatus === 200 ? { access_token: "t", expires_in: 3600 } : {}, state.tokenStatus)
        : url.includes("/users?") ? json({ data: [{ id: "42", display_name: "Example" }] })
          : json({ data: state.streams })),
  };
});

import { syncFeed } from "../../lib/rss-sync";
import { resetTwitchCaches } from "../../lib/twitch";

const dir = mkdtempSync(join(tmpdir(), "feedferret-twitch-sync-"));
let userId = "";
const BROADCAST = { id: "broadcast-1", title: "Synthetic stream", game_name: "Game", started_at: "2026-11-10T12:00:00Z", thumbnail_url: "https://img.example/{width}x{height}.jpg" };

beforeAll(async () => {
  const url = `file:${join(dir, "test.db")}`;
  execFileSync("pnpm", ["exec", "prisma", "db", "push", "--schema", "prisma/schema.generated.prisma"], {
    env: { ...process.env, DATABASE_PROVIDER: "sqlite", DATABASE_URL: url },
    stdio: "pipe",
  });
  state.db = new PrismaClient({ adapter: new PrismaBetterSqlite3({ url }) });
  // Threshold 1: a single counted failure would auto-mute the feed.
  userId = (await state.db.user.create({ data: { email: "twitch@test", name: "Twitch", autoMuteFailingFeedsAfter: 1 } })).id;
}, 120_000);

afterAll(async () => {
  await state.db?.$disconnect();
  rmSync(dir, { recursive: true, force: true });
});

async function configure(enabled: boolean) {
  const data = enabled ? { twitchClientId: "synthetic-id", twitchClientSecret: "sealed" } : { twitchClientId: null, twitchClientSecret: null };
  await state.db.globalSettings.upsert({ where: { id: "global" }, update: data, create: { id: "global", ...data } });
}

beforeEach(async () => {
  state.tokenStatus = 200;
  state.streams = [];
  resetTwitchCaches();
  await state.db.feed.deleteMany({ where: { userId } });
  await configure(true);
});

describe("Twitch feeds through syncFeed", () => {
  it("a second sync of the same live broadcast changes no row and does not bump updatedAt", async () => {
    state.streams = [BROADCAST];
    const feed = await state.db.feed.create({ data: { userId, name: "Twitch · Example", url: "feedferret://twitch/example/live" } });
    expect((await syncFeed(userId, feed.id)).success).toBe(true);
    const first = await state.db.article.findMany({ where: { feedId: feed.id } });
    expect(first).toHaveLength(1);
    await new Promise((r) => setTimeout(r, 15));
    expect((await syncFeed(userId, feed.id)).success).toBe(true);
    const second = await state.db.article.findMany({ where: { feedId: feed.id } });
    expect(second).toEqual(first); // every column, incl. updatedAt
  });

  it("an offline poll creates nothing and keeps the feed healthy", async () => {
    const feed = await state.db.feed.create({ data: { userId, name: "Twitch · Example", url: "FEEDFERRET://Twitch/Example/live" } });
    const result = await syncFeed(userId, feed.id);
    expect(result).toMatchObject({ success: true, count: 0 });
    expect(await state.db.article.count({ where: { feedId: feed.id } })).toBe(0);
    expect(await state.db.feed.findUnique({ where: { id: feed.id } })).toMatchObject({ lastStatus: "ok", autoMuted: false });
  });

  it.each([
    ["credentials are not configured", async () => { await configure(false); }],
    ["credentials are rejected", async () => { state.tokenStatus = 400; }],
  ])("defers without failure streak or auto-mute when %s", async (_name, arrange) => {
    await arrange();
    const feed = await state.db.feed.create({ data: { userId, name: "Twitch · Example", url: "feedferret://twitch/example/live" } });
    for (let i = 0; i < 3; i++) {
      expect(await syncFeed(userId, feed.id)).toMatchObject({ success: true, skipped: true, deferred: true });
    }
    expect(await state.db.feed.findUnique({ where: { id: feed.id } })).toMatchObject({ autoMuted: false, consecutiveFailureCount: 0, lastStatus: null });
    expect(await state.db.notification.count({ where: { feedId: feed.id } })).toBe(0);
  });

  it("resumes normally once credentials return", async () => {
    const feed = await state.db.feed.create({ data: { userId, name: "Twitch · Example", url: "feedferret://twitch/example/live" } });
    await configure(false);
    expect(await syncFeed(userId, feed.id)).toMatchObject({ deferred: true });
    await configure(true);
    state.streams = [BROADCAST];
    expect(await syncFeed(userId, feed.id)).toMatchObject({ success: true, count: 1 });
    expect(await state.db.feed.findUnique({ where: { id: feed.id } })).toMatchObject({ autoMuted: false, lastStatus: "ok" });
  });
});
