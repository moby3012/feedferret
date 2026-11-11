// M8 PR 4 (security audit #2): the app reads v2-sealed secrets everywhere,
// still writes the legacy format, and never ships secrets to the client.
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { PrismaClient } from "@prisma/client";
import { PrismaBetterSqlite3 } from "@prisma/adapter-better-sqlite3";

const state = vi.hoisted(() => ({
  db: null as unknown as PrismaClient,
  session: null as null | { user: { id: string }; authenticatedAt?: number },
  sent: [] as Array<{ channel: string; config: unknown }>,
}));
vi.mock("@/lib/db", () => ({
  get db() {
    return state.db;
  },
  getDatabaseProvider: () => "sqlite",
}));
vi.mock("@/auth", () => ({ auth: vi.fn(async () => state.session) }));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn(), revalidateTag: vi.fn() }));
vi.mock("next-intl/server", () => ({ getTranslations: async () => (key: string) => key }));
vi.mock("@/lib/notification-channels", () => ({
  sendTelegramNotification: async (config: unknown) => (state.sent.push({ channel: "telegram", config }), { ok: true }),
  sendGotifyNotification: async (config: unknown) => (state.sent.push({ channel: "gotify", config }), { ok: true }),
  sendNtfyNotification: async (config: unknown) => (state.sent.push({ channel: "ntfy", config }), { ok: true }),
}));

import { sealSecret, SecretKeyError } from "../../lib/secret-box";
import { loadKeyring } from "../../lib/secret-box-core.mjs";
import { generateTotpToken } from "../../lib/totp";
import { consumeTotpToken } from "../../lib/totp-consume";
import { verifyStepUp } from "../../lib/step-up";
import { readFeedCredentials } from "../../lib/feed-secrets";
import { getWebhookConfig, redactWebhookConfigs } from "../../lib/webhooks";
import { createGReaderToken, verifyGReaderToken } from "../../lib/greader";
import { generateMarkReadUrl, verifyMarkReadUrl } from "../../lib/telegram-callback";
import {
  confirmTwoFactorSetup,
  disableTwoFactor,
  getNotificationChannels,
  testNotificationChannel,
  updateNotificationChannels,
} from "../../app/actions/settings";
import { createAutoReadRule, getAutoReadRules, getFeedEditConfig, updateAutoReadRule } from "../../app/actions/feeds";
import { collectSecretStatus } from "../../scripts/secrets-cli.mjs";

const AUTH = "m8-test-auth-secret-with-plenty-of-random-chars-42";
const TOTP = "JBSWY3DPEHPK3PXPJBSWY3DPEHPK3PXP";
const S = {
  telegram: "123456:S3CRET-telegram-bot-token",
  gotify: "S3CRET-gotify-app-token",
  ntfy: "S3CRET-ntfy-token",
  webhook: "S3CRET-webhook-hmac",
  header: "Bearer S3CRET-webhook-header",
  password: "S3CRET-feed-pass",
  cookie: "sid=S3CRET-cookie",
};

const dir = mkdtempSync(join(tmpdir(), "feedferret-m8-"));
const ids = { plainUser: "", sealedUser: "", feedPlain: "", feedSealed: "" };
let savedAuth: string | undefined;

beforeAll(async () => {
  savedAuth = process.env.AUTH_SECRET;
  process.env.AUTH_SECRET = AUTH;
  const url = `file:${join(dir, "test.db")}`;
  execFileSync("pnpm", ["exec", "prisma", "db", "push", "--schema", "prisma/schema.generated.prisma"], {
    env: { ...process.env, DATABASE_PROVIDER: "sqlite", DATABASE_URL: url },
    stdio: "pipe",
  });
  state.db = new PrismaClient({ adapter: new PrismaBetterSqlite3({ url }) });
  ids.plainUser = (await state.db.user.create({
    data: {
      email: "plain@test", twoFactorEnabled: true, twoFactorSecret: TOTP,
      telegramEnabled: true, telegramBotToken: S.telegram, telegramChatId: "42",
      gotifyEnabled: true, gotifyUrl: "https://gotify.example", gotifyToken: S.gotify,
      ntfyEnabled: true, ntfyUrl: "https://ntfy.example/t", ntfyToken: S.ntfy,
    },
  })).id;
  ids.sealedUser = (await state.db.user.create({
    data: {
      email: "sealed@test", twoFactorEnabled: true, twoFactorSecret: sealSecret("user.twoFactorSecret", TOTP),
      telegramEnabled: true, telegramBotToken: sealSecret("user.telegramBotToken", S.telegram), telegramChatId: "42",
      gotifyEnabled: true, gotifyUrl: "https://gotify.example", gotifyToken: sealSecret("user.gotifyToken", S.gotify),
      ntfyEnabled: true, ntfyUrl: "https://ntfy.example/t", ntfyToken: sealSecret("user.ntfyToken", S.ntfy),
    },
  })).id;
  const httpOptions = JSON.stringify({ CURLOPT_COOKIE: S.cookie });
  ids.feedPlain = (await state.db.feed.create({
    data: { name: "Plain", url: "https://a.example/feed", userId: ids.sealedUser, authType: "basic", authUsername: "u", authPassword: S.password, httpOptions },
  })).id;
  ids.feedSealed = (await state.db.feed.create({
    data: {
      name: "Sealed", url: "https://b.example/feed", userId: ids.sealedUser, authType: "basic",
      authUsername: sealSecret("feed.authUsername", "u"),
      authPassword: sealSecret("feed.authPassword", S.password),
      httpOptions: sealSecret("feed.httpOptions", httpOptions),
    },
  })).id;
}, 120_000);

afterAll(async () => {
  if (savedAuth === undefined) delete process.env.AUTH_SECRET;
  else process.env.AUTH_SECRET = savedAuth;
  await state.db?.$disconnect();
  rmSync(dir, { recursive: true, force: true });
});

beforeEach(() => {
  state.sent = [];
  process.env.AUTH_SECRET = AUTH;
  delete process.env.FEEDFERRET_ENCRYPTION_KEYS_OLD;
  delete process.env.FEEDFERRET_ENCRYPTION_KEY;
});

function expectNoSecrets(payload: unknown) {
  const text = JSON.stringify(payload);
  expect(text).not.toContain("S3CRET");
  expect(text).not.toMatch(/ff2\./);
  expect(text).not.toContain(TOTP);
}

async function resetTotp(userId: string) {
  await state.db.user.update({ where: { id: userId }, data: { twoFactorLastAcceptedStep: null } });
}

describe("TOTP with plaintext and v2-sealed secrets", () => {
  it.each(["plainUser", "sealedUser"] as const)("%s: a code is accepted once, the replay is rejected", async (who) => {
    const userId = ids[who];
    await resetTotp(userId);
    const stored = (await state.db.user.findUniqueOrThrow({ where: { id: userId } })).twoFactorSecret!;
    const code = generateTotpToken(TOTP);
    expect(await consumeTotpToken(userId, stored, code)).toBe(true);
    expect(await consumeTotpToken(userId, stored, code)).toBe(false);
    expect(await consumeTotpToken(userId, stored, "000000")).toBe(false);
  });

  it.each(["plainUser", "sealedUser"] as const)("%s: concurrent use of one code succeeds exactly once", async (who) => {
    const userId = ids[who];
    await resetTotp(userId);
    const stored = (await state.db.user.findUniqueOrThrow({ where: { id: userId } })).twoFactorSecret!;
    const code = generateTotpToken(TOTP);
    const results = await Promise.all([1, 2, 3, 4].map(() => consumeTotpToken(userId, stored, code)));
    expect(results.filter(Boolean)).toHaveLength(1);
  });

  it("the CAS compares the stored string: a secret changed in between fails the claim", async () => {
    await resetTotp(ids.sealedUser);
    const staleStored = sealSecret("user.twoFactorSecret", TOTP); // same plaintext, different ciphertext
    expect(await consumeTotpToken(ids.sealedUser, staleStored, generateTotpToken(TOTP))).toBe(false);
  });

  it("an undecryptable secret (unknown key id) fails closed without throwing", async () => {
    await resetTotp(ids.sealedUser);
    const stored = (await state.db.user.findUniqueOrThrow({ where: { id: ids.sealedUser } })).twoFactorSecret!;
    process.env.AUTH_SECRET = "a-completely-different-auth-secret-value-xyz";
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    await expect(consumeTotpToken(ids.sealedUser, stored, generateTotpToken(TOTP))).resolves.toBe(false);
    expect(JSON.stringify(warn.mock.calls)).not.toContain(TOTP);
    warn.mockRestore();
    // with the old key in _OLD, the same login works again
    process.env.FEEDFERRET_ENCRYPTION_KEYS_OLD = AUTH;
    expect(await consumeTotpToken(ids.sealedUser, stored, generateTotpToken(TOTP))).toBe(true);
  });

  it("step-up and disable accept a code for a sealed secret", async () => {
    await resetTotp(ids.sealedUser);
    expect(await verifyStepUp({ id: ids.sealedUser }, { totp: generateTotpToken(TOTP) })).toEqual({ ok: true });
    state.session = { user: { id: ids.sealedUser } };
    await expect(disableTwoFactor(generateTotpToken(TOTP))).resolves.toEqual({ enabled: false });
    // setup confirmation with a sealed pending secret (written by the next release)
    await state.db.user.update({ where: { id: ids.sealedUser }, data: { twoFactorSecret: sealSecret("user.twoFactorSecret", TOTP) } });
    await expect(confirmTwoFactorSetup(generateTotpToken(TOTP))).resolves.toEqual({ enabled: true });
  });
});

describe("notification channel tokens are write-only", () => {
  it.each(["plainUser", "sealedUser"] as const)("%s: settings payload has presence flags, no tokens", async (who) => {
    state.session = { user: { id: ids[who] } };
    const channels = await getNotificationChannels();
    expectNoSecrets(channels);
    expect(channels).toMatchObject({ hasTelegramBotToken: true, hasGotifyToken: true, hasNtfyToken: true, telegramChatId: "42" });
    expect(channels).not.toHaveProperty("telegramBotToken");
  });

  it.each(["plainUser", "sealedUser"] as const)("%s: test sends with the decrypted tokens", async (who) => {
    state.session = { user: { id: ids[who] } };
    expect(await testNotificationChannel("telegram")).toEqual({ success: true, error: undefined });
    expect(await testNotificationChannel("gotify")).toEqual({ success: true, error: undefined });
    expect(await testNotificationChannel("ntfy")).toEqual({ success: true, error: undefined });
    expect(state.sent.map((s) => s.config)).toEqual([
      { botToken: S.telegram, chatId: "42" },
      { url: "https://gotify.example", token: S.gotify },
      { url: "https://ntfy.example/t", token: S.ntfy },
    ]);
  });

  it("update keeps tokens on omitted / blank / __keep__, clears on null, stores new values in the legacy format", async () => {
    state.session = { user: { id: ids.sealedUser } };
    const before = await state.db.user.findUniqueOrThrow({ where: { id: ids.sealedUser } });
    await updateNotificationChannels({ telegramChatId: "43", telegramBotToken: "", gotifyToken: "__keep__" });
    let row = await state.db.user.findUniqueOrThrow({ where: { id: ids.sealedUser } });
    expect(row.telegramBotToken).toBe(before.telegramBotToken);
    expect(row.gotifyToken).toBe(before.gotifyToken);
    expect(row.ntfyToken).toBe(before.ntfyToken);
    expect(row.telegramChatId).toBe("43");

    await updateNotificationChannels({ ntfyToken: null, gotifyToken: " new-gotify " });
    row = await state.db.user.findUniqueOrThrow({ where: { id: ids.sealedUser } });
    expect(row.ntfyToken).toBeNull();
    expect(row.gotifyToken).toBe("new-gotify"); // PR 4 still writes the old (plaintext) format

    // untrusted input of the wrong type is ignored, never spread into Prisma
    await updateNotificationChannels({ telegramBotToken: 5, evil: "x", telegramEnabled: "yes" } as never);
    expect((await state.db.user.findUniqueOrThrow({ where: { id: ids.sealedUser } })).telegramBotToken).toBe(before.telegramBotToken);
  });
});

describe("webhook secrets", () => {
  it("rules reach the client without secrets; an empty secret with its secretRef keeps the stored one", async () => {
    state.session = { user: { id: ids.plainUser } };
    const created = await createAutoReadRule({
      name: "hook", query: "x", actions: ["webhook_call:0"],
      webhookConfigs: [{ url: "https://hook.example/a", secret: S.webhook, headers: { Authorization: S.header } }],
    });
    expect(JSON.stringify(created)).not.toContain(S.webhook);
    const [rule] = (await getAutoReadRules()).filter((r) => r.id === created.id);
    expect(JSON.stringify(rule)).not.toContain(S.webhook);
    const ui = JSON.parse(rule.webhookConfigs!);
    expect(ui[0]).toMatchObject({ hasSecret: true, secretRef: 0 });

    // the UI re-saves with an added webhook in front: the kept secret follows its secretRef
    await updateAutoReadRule(created.id, {
      actions: ["webhook_call:0", "webhook_call:1"],
      webhookConfigs: [{ url: "https://hook.example/new" }, { ...ui[0], secret: "" }],
    });
    const stored = (await state.db.autoReadRule.findUniqueOrThrow({ where: { id: created.id } })).webhookConfigs!;
    expect(JSON.parse(stored)).toEqual([
      { url: "https://hook.example/new", method: "POST" },
      { url: "https://hook.example/a", method: "POST", headers: { Authorization: S.header }, secret: S.webhook },
    ]);

    // a removed reference drops the secret
    await updateAutoReadRule(created.id, { webhookConfigs: [{ url: "https://hook.example/a" }] });
    expect(JSON.parse((await state.db.autoReadRule.findUniqueOrThrow({ where: { id: created.id } })).webhookConfigs!)[0].secret).toBeUndefined();
  });

  it("execution reads sealed secret and header values; redaction exposes neither secret nor ciphertext", () => {
    const raw = JSON.stringify([
      { url: "https://hook.example/a", secret: sealSecret("autoReadRule.webhookConfigs.secret", S.webhook), headers: { Authorization: sealSecret("autoReadRule.webhookConfigs.header", S.header) } },
      { url: "https://hook.example/b", secret: S.webhook },
    ]);
    expect(getWebhookConfig({ webhookConfigs: raw }, 0)).toMatchObject({ secret: S.webhook, headers: { Authorization: S.header } });
    expect(getWebhookConfig({ webhookConfigs: raw }, 1)).toMatchObject({ secret: S.webhook });
    const redacted = redactWebhookConfigs(raw);
    expect(JSON.stringify(redacted)).not.toContain(S.webhook);
    expect(JSON.stringify(redacted)).not.toMatch(/ff2\./);
    expect(redacted[0]).toMatchObject({ hasSecret: true, headers: { Authorization: S.header } });
  });

  it("an undecryptable webhook is skipped, never fired unsigned", () => {
    const raw = JSON.stringify([{ url: "https://hook.example/a", secret: sealSecret("autoReadRule.webhookConfigs.secret", S.webhook) }]);
    process.env.AUTH_SECRET = "a-completely-different-auth-secret-value-xyz";
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    expect(getWebhookConfig({ webhookConfigs: raw }, 0)).toBeNull();
    vi.restoreAllMocks();
  });
});

describe("feed credentials", () => {
  it.each(["feedPlain", "feedSealed"] as const)("%s: owner edit config is decrypted, the password stays write-only", async (which) => {
    state.session = { user: { id: ids.sealedUser } };
    const config = await getFeedEditConfig(ids[which]);
    expect(config).toEqual({ authUsername: "u", hasAuthPassword: true, scraperConfig: null, httpOptions: JSON.stringify({ CURLOPT_COOKIE: S.cookie }) });
    expect(JSON.stringify(config)).not.toContain(S.password);
  });

  it("readFeedCredentials opens both formats and fails loudly (no silent empty password) with the wrong key", async () => {
    const row = await state.db.feed.findUniqueOrThrow({ where: { id: ids.feedSealed } });
    expect(readFeedCredentials(row)).toMatchObject({ authUsername: "u", authPassword: S.password, httpOptions: JSON.stringify({ CURLOPT_COOKIE: S.cookie }) });
    process.env.AUTH_SECRET = "a-completely-different-auth-secret-value-xyz";
    expect(() => readFeedCredentials(row)).toThrow(SecretKeyError);
  });
});

describe("HMAC: tokens issued now still verify; derived-key tokens of the next release verify too", () => {
  it("GReader and Telegram", () => {
    const token = createGReaderToken("user-1", 3);
    expect(verifyGReaderToken(token)).toBe("user-1");
    expect(verifyGReaderToken(token.replace(/.$/, (c) => (c === "a" ? "b" : "a")))).toBeNull();
    const url = new URL(generateMarkReadUrl("art-1", "user-1", "https://ff.example"));
    const p = url.searchParams;
    expect(verifyMarkReadUrl(p.get("id")!, p.get("uid")!, p.get("exp")!, p.get("sig")!)).toBe(true);
    expect(verifyMarkReadUrl("art-2", p.get("uid")!, p.get("exp")!, p.get("sig")!)).toBe(false);
  });
});

describe("secrets:status", () => {
  it("counts every column by format and key id, never outputs a value", async () => {
    await state.db.user.update({ where: { id: ids.plainUser }, data: { aiApiKey: "not-v1-garbage" } });
    const status = await collectSecretStatus(state.db, loadKeyring(process.env));
    const kid = loadKeyring(process.env).current.kid;
    const by = Object.fromEntries(status.columns.map((c: { column: string; counts: Record<string, number> }) => [c.column, c.counts]));
    expect(by["user.telegramBotToken"]).toEqual({ plaintext: 1, [`v2:${kid}:current`]: 1 });
    expect(by["feed.authPassword"]).toEqual({ plaintext: 1, [`v2:${kid}:current`]: 1 });
    expect(by["user.aiApiKey"]).toEqual({ undecryptable: 1 });
    expect(status.undecryptable).toBe(1);
    expectNoSecrets(status);

    process.env.AUTH_SECRET = "a-completely-different-auth-secret-value-xyz";
    const rotated = await collectSecretStatus(state.db, loadKeyring(process.env));
    const rotatedBy = Object.fromEntries(rotated.columns.map((c: { column: string; counts: Record<string, number> }) => [c.column, c.counts]));
    expect(rotatedBy["user.telegramBotToken"]).toEqual({ plaintext: 1, [`v2:${kid}:unknown`]: 1 });
    expect(rotated.undecryptable).toBeGreaterThan(1);
  });
});
