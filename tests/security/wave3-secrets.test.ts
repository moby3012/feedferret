// Security wave 3 (audit #2): N4 — no feed secrets in bootstrap / feed-list
// payloads; N3 — connector keys never in client-facing feed URLs, stripped
// from stored URLs; N17 — email change needs step-up.
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import bcrypt from "bcryptjs";
import { PrismaClient } from "@prisma/client";
import { PrismaBetterSqlite3 } from "@prisma/adapter-better-sqlite3";

const state = vi.hoisted(() => ({
  db: null as unknown as PrismaClient,
  session: null as null | { user: { id: string }; authenticatedAt?: number },
}));
vi.mock("@/lib/db", () => ({
  get db() {
    return state.db;
  },
  getDatabaseProvider: () => "sqlite",
}));
vi.mock("@/auth", () => ({ auth: vi.fn(async () => state.session) }));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn(), revalidateTag: vi.fn() }));

import { getAutoReadRules, getFeedEditConfig, getFeedHealth, getFeeds, updateFeed, previewFeedContentRules } from "../../app/actions/feeds";
import { getNotificationChannels, updateProfile } from "../../app/actions/settings";
import { sealSecret } from "../../lib/secret-box";
import { getBootstrap } from "../../server/bootstrap";
import { migrateConnectorFeedUrls, resetConnectorSecretRulesCache } from "../../lib/connector-secrets";

const SECRETS = {
  password: "S3CRET-feed-password",
  username: "secret-feed-user",
  cookie: "SESSIONID=S3CRET-cookie-value",
  proxy: "http://proxyuser:S3CRET-proxy-pass@proxy.example:8080",
  scraper: "S3CRET-scraper-marker",
  rsshubKey: "S3CRET-rsshub-key",
};

const dir = mkdtempSync(join(tmpdir(), "feedferret-wave3-"));
const ids = { alice: "", bob: "", feed: "", rsshubFeed: "", dupFeed: "" };

beforeAll(async () => {
  const url = `file:${join(dir, "test.db")}`;
  execFileSync("pnpm", ["exec", "prisma", "db", "push", "--schema", "prisma/schema.generated.prisma"], {
    env: { ...process.env, DATABASE_PROVIDER: "sqlite", DATABASE_URL: url },
    stdio: "pipe",
  });
  state.db = new PrismaClient({ adapter: new PrismaBetterSqlite3({ url }) });
  ids.alice = (await state.db.user.create({ data: { email: "alice@test", name: "Alice" } })).id;
  ids.bob = (await state.db.user.create({ data: { email: "bob@test", name: "Bob" } })).id;
  ids.feed = (await state.db.feed.create({
    data: {
      name: "Private",
      url: "https://private.example/feed",
      userId: ids.alice,
      authType: "basic",
      authUsername: SECRETS.username,
      authPassword: SECRETS.password,
      httpOptions: JSON.stringify({ CURLOPT_COOKIE: SECRETS.cookie, CURLOPT_PROXY: SECRETS.proxy }),
      scraperConfig: JSON.stringify({ marker: SECRETS.scraper }),
      lastError: `Fetch failed for https://rsshub.test/x?key=${SECRETS.rsshubKey}`,
    },
  })).id;
  ids.rsshubFeed = (await state.db.feed.create({
    data: { name: "YT", url: `https://rsshub.test/youtube/channel/abc?key=${SECRETS.rsshubKey}`, userId: ids.alice },
  })).id;
  // A keyed legacy row whose keyless twin already exists: migration must skip it.
  await state.db.feed.create({ data: { name: "Twin", url: "https://rsshub.test/github/repo/a/b", userId: ids.alice } });
  ids.dupFeed = (await state.db.feed.create({
    data: { name: "Twin keyed", url: `https://rsshub.test/github/repo/a/b?key=${SECRETS.rsshubKey}`, userId: ids.alice },
  })).id;
  process.env.FEEDFERRET_RSSHUB_URL = "https://rsshub.test";
  process.env.FEEDFERRET_RSSHUB_KEY = SECRETS.rsshubKey;
}, 120_000);

afterAll(async () => {
  delete process.env.FEEDFERRET_RSSHUB_URL;
  delete process.env.FEEDFERRET_RSSHUB_KEY;
  await state.db?.$disconnect();
  rmSync(dir, { recursive: true, force: true });
});

beforeEach(() => {
  resetConnectorSecretRulesCache();
  state.session = { user: { id: ids.alice } };
});

function expectNoSecrets(payload: unknown) {
  const text = JSON.stringify(payload);
  for (const secret of Object.values(SECRETS)) expect(text).not.toContain(secret);
  expect(text).not.toContain("S3CRET");
}

describe("N4: feed secrets never reach list / bootstrap payloads", () => {
  it("getBootstrap (SSR-embedded) carries no credentials, fetch options or connector keys", async () => {
    const boot = await getBootstrap(ids.alice);
    expect(boot.feeds.length).toBe(4);
    expectNoSecrets(boot);
    const feed = boot.feeds.find((f) => f.id === ids.feed) as Record<string, unknown>;
    for (const field of ["authPassword", "authUsername", "httpOptions", "scraperConfig", "etag", "lastModifiedHeader"]) {
      expect(feed).not.toHaveProperty(field);
    }
    // Non-secret config the settings dialog still needs stays.
    expect(feed.authType).toBe("basic");
    expect(feed.name).toBe("Private");
  });

  it("getFeeds and getFeedHealth (server actions) carry no secrets", async () => {
    expectNoSecrets(await getFeeds());
    expectNoSecrets(await getFeedHealth());
  });

  it("getFeedEditConfig is owner-only and never returns the password", async () => {
    const config = await getFeedEditConfig(ids.feed);
    expect(config).toEqual({
      authUsername: SECRETS.username,
      hasAuthPassword: true,
      contentRules: null,
      scraperConfig: JSON.stringify({ marker: SECRETS.scraper }),
      // Cookies / proxy credentials are write-only too (M8 review): masked as "__keep__".
      httpOptions: JSON.stringify({ CURLOPT_COOKIE: "__keep__", CURLOPT_PROXY: "__keep__" }),
      maskedHttpOptions: ["CURLOPT_COOKIE", "CURLOPT_PROXY"],
    });
    for (const secret of [SECRETS.password, SECRETS.cookie, SECRETS.proxy]) expect(JSON.stringify(config)).not.toContain(secret);
    state.session = { user: { id: ids.bob } };
    await expect(getFeedEditConfig(ids.feed)).rejects.toThrow("Feed not found");
  });

  it("bounds content-rule preview selectors and rate-limits requests on the server", async () => {
    await expect(previewFeedContentRules(ids.feed, "{}", "x".repeat(1001))).rejects.toThrow("1000");
    for (let i = 0; i < 30; i++) await previewFeedContentRules(ids.feed, "{}");
    await expect(previewFeedContentRules(ids.feed, "{}")).rejects.toThrow("Too many previews");
  });

  it("updateFeed keeps the stored password when the dialog omits it", async () => {
    await updateFeed(ids.feed, { name: "Private 2", authType: "basic", authUsername: SECRETS.username });
    const row = await state.db.feed.findUniqueOrThrow({ where: { id: ids.feed } });
    expect(row.authPassword).toBe(SECRETS.password);
    expect(row.name).toBe("Private 2");
  });
});

describe("M8: v2-sealed secrets and notification/webhook secrets stay off client payloads", () => {
  it("sealed feed credentials and ciphertexts never reach list / bootstrap payloads", async () => {
    const savedAuth = process.env.AUTH_SECRET;
    process.env.AUTH_SECRET = "wave3-payload-test-auth-secret-with-enough-chars";
    try {
      const sealed = await state.db.feed.create({
        data: {
          name: "Sealed", url: "https://sealed.example/feed", userId: ids.alice, authType: "basic",
          authUsername: sealSecret("feed.authUsername", SECRETS.username),
          authPassword: sealSecret("feed.authPassword", SECRETS.password),
          httpOptions: sealSecret("feed.httpOptions", JSON.stringify({ CURLOPT_COOKIE: SECRETS.cookie })),
        },
      });
      for (const payload of [await getBootstrap(ids.alice), await getFeeds(), await getFeedHealth()]) {
        expectNoSecrets(payload);
        expect(JSON.stringify(payload)).not.toContain("ff2.");
      }
      await state.db.feed.delete({ where: { id: sealed.id } });
    } finally {
      if (savedAuth === undefined) delete process.env.AUTH_SECRET;
      else process.env.AUTH_SECRET = savedAuth;
    }
  });

  it("notification settings and rules carry presence flags, not tokens or webhook secrets", async () => {
    await state.db.user.update({
      where: { id: ids.alice },
      data: { telegramBotToken: "1:S3CRET-tg", gotifyToken: "S3CRET-gotify", ntfyToken: "S3CRET-ntfy" },
    });
    const rule = await state.db.autoReadRule.create({
      data: { userId: ids.alice, name: "hook", query: "x", action: "webhook_call:0", webhookConfigs: JSON.stringify([{ url: "https://hook.example", secret: "S3CRET-hmac" }]) },
    });
    const channels = await getNotificationChannels();
    expectNoSecrets(channels);
    expect(channels).toMatchObject({ hasTelegramBotToken: true, hasGotifyToken: true, hasNtfyToken: true });
    expectNoSecrets(await getAutoReadRules());
    await state.db.autoReadRule.delete({ where: { id: rule.id } });
  });
});

describe("N3: connector keys stay server-side", () => {
  it("feed lists show the keyless RSSHub URL", async () => {
    const feeds = await getFeeds();
    const yt = feeds.find((f) => f.id === ids.rsshubFeed)!;
    expect(yt.url).toBe("https://rsshub.test/youtube/channel/abc");
  });

  it("migration strips the key (current or rotated) once, skips clashes, and is idempotent", async () => {
    const stale = await state.db.feed.create({ data: { name: "Stale", url: "https://rsshub.test/reddit/r/x?key=rotated-old-key", userId: ids.bob } });
    const first = await migrateConnectorFeedUrls(state.db as never);
    expect(first.migrated).toBe(2);
    expect((await state.db.feed.findUniqueOrThrow({ where: { id: stale.id } })).url).toBe("https://rsshub.test/reddit/r/x");
    const yt = await state.db.feed.findUniqueOrThrow({ where: { id: ids.rsshubFeed } });
    expect(yt.url).toBe("https://rsshub.test/youtube/channel/abc");
    const dup = await state.db.feed.findUniqueOrThrow({ where: { id: ids.dupFeed } });
    expect(dup.url).toContain("key="); // twin exists → left alone, still redacted on output
    expect(first.skipped).toBe(1);
    const second = await migrateConnectorFeedUrls(state.db as never);
    expect(second.migrated).toBe(0);
    expectNoSecrets(await getFeeds());
  });
});

describe("N17: email change requires step-up", () => {
  it("name-only updates need no step-up", async () => {
    const result = await updateProfile({ name: "Alice A", email: "alice@test" });
    expect(result).toMatchObject({ success: true, emailChanged: false });
  });

  it("a password account must prove the current password", async () => {
    await state.db.user.update({ where: { id: ids.alice }, data: { password: await bcrypt.hash("correct horse", 4) } });
    expect(await updateProfile({ email: "evil@test" })).toEqual({ success: false, code: "stepUpRequired" });
    expect(await updateProfile({ email: "evil@test", currentPassword: "wrong" })).toEqual({ success: false, code: "stepUpRequired" });
    expect((await state.db.user.findUniqueOrThrow({ where: { id: ids.alice } })).email).toBe("alice@test");

    const ok = await updateProfile({ email: "alice2@test", currentPassword: "correct horse" });
    expect(ok).toMatchObject({ success: true, emailChanged: true });
    expect((await state.db.user.findUniqueOrThrow({ where: { id: ids.alice } })).email).toBe("alice2@test");
  });

  it("a passwordless account needs a sign-in within the last 10 minutes", async () => {
    state.session = { user: { id: ids.bob }, authenticatedAt: Math.floor(Date.now() / 1000) - 3600 };
    expect(await updateProfile({ email: "bob2@test" })).toEqual({ success: false, code: "reloginRequired" });
    state.session = { user: { id: ids.bob }, authenticatedAt: Math.floor(Date.now() / 1000) - 60 };
    expect(await updateProfile({ email: "bob2@test" })).toMatchObject({ success: true, emailChanged: true });
  });

  it("rejects an invalid new address", async () => {
    state.session = { user: { id: ids.bob }, authenticatedAt: Math.floor(Date.now() / 1000) };
    expect(await updateProfile({ email: "not an email" })).toEqual({ success: false, code: "invalidEmail" });
  });
});
