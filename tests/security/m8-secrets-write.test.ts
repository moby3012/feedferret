// M8 PR 5 (security audit #2): every writer stores secrets v2-sealed, legacy
// values are re-sealed by the migration (migrate / rotate), and nothing ever
// outputs a secret. Real SQLite DB; the app's db is the same write extension
// lib/db.ts installs (withSecretSealing).
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { createHmac } from "node:crypto";
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
vi.mock("next-intl/server", () => ({ getTranslations: async () => (key: string) => key }));

import { SECRET_COLUMNS, isV2, loadKeyring, openSecret as openCore, sealV2, v2KeyId } from "../../lib/secret-box-core.mjs";
import { migrateSecrets, redactId } from "../../lib/secret-migration-core.mjs";
import { SecretKeyError, openSecret, sealSecret } from "../../lib/secret-box";
import { sealWriteArgs, withSecretSealing } from "../../lib/secret-sealing";
import { encrypt } from "../../lib/crypto";
import { generateTotpToken } from "../../lib/totp";
import { consumeTotpToken } from "../../lib/totp-consume";
import { readFeedCredentials } from "../../lib/feed-secrets";
import { getWebhookConfig } from "../../lib/webhooks";
import { createGReaderToken, verifyGReaderToken } from "../../lib/greader";
import { generateMarkReadUrl, verifyMarkReadUrl } from "../../lib/telegram-callback";
import { beginTwoFactorSetup, updateAiSettings, updateContentFetchSettings, updateNotificationChannels } from "../../app/actions/settings";
import { updateExportSettings } from "../../app/actions/export";
import { updateGlobalSettings } from "../../app/actions/admin";
import { createAutoReadRule, updateFeed } from "../../app/actions/feeds";
import { runSecretMigration, getSecretMigrationState } from "../../lib/secret-migration";
import { main as secretsCli } from "../../scripts/secrets-cli.mjs";

const AUTH = "m8w-test-auth-secret-with-plenty-of-random-chars-42";
const KEY_A = "QUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUE="; // base64, 32 bytes
const KEY_B = "QkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJCQkI=";
const TOTP = "JBSWY3DPEHPK3PXPJBSWY3DPEHPK3PXP";
const S = {
  telegram: "123456:S3CRET-telegram",
  gotify: "S3CRET-gotify",
  ntfy: "S3CRET-ntfy",
  password: "S3CRET:feed:pass", // colons: must never be parsed as v1
  cookie: "sid=S3CRET-cookie",
  webhook: "S3CRET-webhook",
  header: "Bearer S3CRET-header",
  ai: "sk-S3CRET-ai",
  content: "S3CRET-content-key",
  wallabag: "S3CRET-wallabag",
  rsshub: "S3CRET-rsshub",
  smtp: "S3CRET-smtp",
};

const dir = mkdtempSync(join(tmpdir(), "feedferret-m8w-"));
let raw: PrismaClient;
const ids = { user: "", admin: "", feed: "" };
let savedEnv: Record<string, string | undefined>;

function expectNoPlaintext(payload: unknown) {
  const text = typeof payload === "string" ? payload : JSON.stringify(payload);
  expect(text).not.toContain("S3CRET");
  expect(text).not.toContain(TOTP);
}

function expectSealed(value: string | null | undefined, purpose: string, plaintext: string) {
  expect(value).toBeTruthy();
  expect(isV2(value!)).toBe(true);
  expect(openSecret(purpose, value!, "plaintext").value).toBe(plaintext);
}

beforeAll(async () => {
  savedEnv = {
    AUTH_SECRET: process.env.AUTH_SECRET,
    FEEDFERRET_ENCRYPTION_KEY: process.env.FEEDFERRET_ENCRYPTION_KEY,
    FEEDFERRET_ENCRYPTION_KEYS_OLD: process.env.FEEDFERRET_ENCRYPTION_KEYS_OLD,
    DATABASE_URL: process.env.DATABASE_URL,
    DATABASE_PROVIDER: process.env.DATABASE_PROVIDER,
  };
  process.env.AUTH_SECRET = AUTH;
  const url = `file:${join(dir, "test.db")}`;
  execFileSync("pnpm", ["exec", "prisma", "db", "push", "--schema", "prisma/schema.generated.prisma"], {
    env: { ...process.env, DATABASE_PROVIDER: "sqlite", DATABASE_URL: url },
    stdio: "pipe",
  });
  raw = new PrismaClient({ adapter: new PrismaBetterSqlite3({ url }) });
  state.db = withSecretSealing(raw);
  process.env.DATABASE_URL = url;
  process.env.DATABASE_PROVIDER = "sqlite";
  ids.user = (await raw.user.create({ data: { email: "w@test" } })).id;
  ids.admin = (await raw.user.create({ data: { email: "admin@test", role: "ADMIN" } })).id;
  ids.feed = (await raw.feed.create({ data: { name: "F", url: "https://a.example/feed", userId: ids.user } })).id;
}, 120_000);

afterAll(async () => {
  for (const [key, value] of Object.entries(savedEnv)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  await raw?.$disconnect();
  rmSync(dir, { recursive: true, force: true });
});

beforeEach(() => {
  process.env.AUTH_SECRET = AUTH;
  delete process.env.FEEDFERRET_ENCRYPTION_KEY;
  delete process.env.FEEDFERRET_ENCRYPTION_KEYS_OLD;
  delete process.env.FEEDFERRET_LEGACY_MAC_UNTIL;
  state.session = { user: { id: ids.user }, authenticatedAt: Math.floor(Date.now() / 1000) };
});

describe("write extension", () => {
  it("seals every registry column with its own purpose and passes sealed values through", () => {
    for (const column of SECRET_COLUMNS) {
      const model = column.model[0].toUpperCase() + column.model.slice(1);
      const value = column.json ? JSON.stringify([{ url: "https://h.example", secret: "S3CRET-x", headers: { A: "S3CRET-y" } }]) : "S3CRET-value";
      const args = { where: { id: "x" }, data: { [column.column]: value, other: "kept" } };
      const out = sealWriteArgs(model, "update", args) as typeof args;
      expect(args.data[column.column]).toBe(value); // caller's object untouched
      expect(out.data.other).toBe("kept");
      expectNoPlaintext(out);
      if (column.json) {
        expect(getWebhookConfig({ webhookConfigs: out.data[column.column] as string }, 0)).toMatchObject({ secret: "S3CRET-x", headers: { A: "S3CRET-y" } });
      } else {
        expect(openSecret(column.purpose, out.data[column.column] as string, column.legacy).value).toBe("S3CRET-value");
        // sealed values are not re-sealed
        const again = sealWriteArgs(model, "update", out) as typeof args;
        expect(again.data[column.column]).toBe(out.data[column.column]);
      }
    }
  });

  it("covers create, createMany, upsert and { set } and drops OAuth account tokens", () => {
    const many = sealWriteArgs("Feed", "createMany", { data: [{ authPassword: "S3CRET-1" }, { authPassword: null }] }) as { data: Array<{ authPassword: string | null }> };
    expect(isV2(many.data[0].authPassword!)).toBe(true);
    expect(many.data[1].authPassword).toBeNull();
    const up = sealWriteArgs("User", "upsert", { where: { id: "x" }, create: { gotifyToken: "S3CRET-c" }, update: { gotifyToken: { set: "S3CRET-u" } } }) as { create: { gotifyToken: string }; update: { gotifyToken: { set: string } } };
    expect(openSecret("user.gotifyToken", up.create.gotifyToken, "plaintext").value).toBe("S3CRET-c");
    expect(openSecret("user.gotifyToken", up.update.gotifyToken.set, "plaintext").value).toBe("S3CRET-u");
    const account = sealWriteArgs("Account", "create", { data: { provider: "github", access_token: "S3CRET-a", refresh_token: "S3CRET-r", id_token: null } });
    expect(account).toEqual({ data: { provider: "github", access_token: null, refresh_token: null, id_token: null } });
    // v1 ciphertext copied into a v1 column stays (the migration re-seals it); reads are untouched
    const v1 = encrypt("S3CRET-v1");
    expect((sealWriteArgs("User", "update", { data: { aiApiKey: v1 } }) as { data: { aiApiKey: string } }).data.aiApiKey).toBe(v1);
    expect(sealWriteArgs("User", "findMany", { where: { gotifyToken: "x" } })).toEqual({ where: { gotifyToken: "x" } });
  });
});

describe("writer paths store v2", () => {
  it("feed Basic auth and fetch options (updateFeed)", async () => {
    await updateFeed(ids.feed, { authType: "basic", authUsername: "alice", authPassword: S.password, httpOptions: JSON.stringify({ CURLOPT_COOKIE: S.cookie }) });
    const row = await raw.feed.findUniqueOrThrow({ where: { id: ids.feed } });
    expectNoPlaintext(row);
    expectSealed(row.authUsername, "feed.authUsername", "alice");
    expectSealed(row.authPassword, "feed.authPassword", S.password);
    expect(readFeedCredentials(row)).toMatchObject({ authUsername: "alice", authPassword: S.password, httpOptions: JSON.stringify({ CURLOPT_COOKIE: S.cookie }) });
    // a masked re-save keeps the stored cookie and stays sealed
    await updateFeed(ids.feed, { httpOptions: JSON.stringify({ CURLOPT_COOKIE: "__keep__", CURLOPT_USERAGENT: "UA" }) });
    const after = await raw.feed.findUniqueOrThrow({ where: { id: ids.feed } });
    expectSealed(after.httpOptions, "feed.httpOptions", JSON.stringify({ CURLOPT_COOKIE: S.cookie, CURLOPT_USERAGENT: "UA" }));
  });

  it("notification channel tokens (updateNotificationChannels)", async () => {
    await updateNotificationChannels({ telegramBotToken: S.telegram, gotifyToken: S.gotify, ntfyToken: S.ntfy });
    const row = await raw.user.findUniqueOrThrow({ where: { id: ids.user } });
    expectSealed(row.telegramBotToken, "user.telegramBotToken", S.telegram);
    expectSealed(row.gotifyToken, "user.gotifyToken", S.gotify);
    expectSealed(row.ntfyToken, "user.ntfyToken", S.ntfy);
    // blank keeps the sealed value verbatim
    await updateNotificationChannels({ telegramBotToken: "", gotifyToken: "__keep__" });
    const kept = await raw.user.findUniqueOrThrow({ where: { id: ids.user } });
    expect(kept.telegramBotToken).toBe(row.telegramBotToken);
    expect(kept.gotifyToken).toBe(row.gotifyToken);
  });

  it("webhook secret and header values inside the rule JSON (createAutoReadRule)", async () => {
    const created = await createAutoReadRule({
      name: "hook", query: "x", actions: ["webhook_call:0"],
      webhookConfigs: [{ url: "https://hook.example/a", secret: S.webhook, headers: { Authorization: S.header } }],
    });
    expectNoPlaintext(created);
    const stored = (await raw.autoReadRule.findUniqueOrThrow({ where: { id: created.id } })).webhookConfigs!;
    expectNoPlaintext(stored);
    const parsed = JSON.parse(stored);
    expect(parsed[0].url).toBe("https://hook.example/a");
    expect(isV2(parsed[0].secret) && isV2(parsed[0].headers.Authorization)).toBe(true);
    expect(getWebhookConfig({ webhookConfigs: stored }, 0)).toMatchObject({ secret: S.webhook, headers: { Authorization: S.header } });
  });

  it("AI provider, content fetch and Wallabag keys (settings actions)", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    await updateAiSettings({ apiKey: S.ai });
    await updateContentFetchSettings({ apiKey: S.content });
    await updateExportSettings({ wallabagClientSecret: S.wallabag, wallabagPassword: S.wallabag });
    const row = await raw.user.findUniqueOrThrow({ where: { id: ids.user } });
    expectSealed(row.aiApiKey, "user.aiApiKey", S.ai);
    expectSealed(row.contentFetchApiKey, "user.contentFetchApiKey", S.content);
    expectSealed(row.exportWallabagClientSecret, "user.exportWallabagClientSecret", S.wallabag);
    expectSealed(row.exportWallabagPassword, "user.exportWallabagPassword", S.wallabag);
    vi.restoreAllMocks();
  });

  it("mail and connector credentials (admin updateGlobalSettings)", async () => {
    state.session = { user: { id: ids.admin } };
    await updateGlobalSettings({ rsshubApiKey: S.rsshub, smtpPassword: S.smtp, changedetectionApiKey: "S3CRET-cd" });
    const row = await raw.globalSettings.findUniqueOrThrow({ where: { id: "global" } });
    expectSealed(row.rsshubApiKey, "globalSettings.rsshubApiKey", S.rsshub);
    expectSealed(row.smtpPassword, "globalSettings.smtpPassword", S.smtp);
    expectSealed(row.changedetectionApiKey, "globalSettings.changedetectionApiKey", "S3CRET-cd");
  });

  it("TOTP seed (beginTwoFactorSetup) and newsletter IMAP credentials (any write)", async () => {
    const { secret } = await beginTwoFactorSetup();
    const row = await raw.user.findUniqueOrThrow({ where: { id: ids.user } });
    expectSealed(row.twoFactorSecret, "user.twoFactorSecret", secret);
    const source = await state.db.inboundMailSource.create({
      data: { name: "imap", kind: "imap", credentials: JSON.stringify({ user: "u", pass: "S3CRET-imap" }), webhookSecret: "S3CRET-hook" },
    });
    const stored = await raw.inboundMailSource.findUniqueOrThrow({ where: { id: source.id } });
    expectSealed(stored.credentials, "inboundMailSource.credentials", JSON.stringify({ user: "u", pass: "S3CRET-imap" }));
    expectSealed(stored.webhookSecret, "inboundMailSource.webhookSecret", "S3CRET-hook");
    await raw.inboundMailSource.delete({ where: { id: source.id } });
  });

  it("a successful TOTP login lazily re-seals a legacy plaintext seed (CAS)", async () => {
    await raw.user.update({ where: { id: ids.user }, data: { twoFactorEnabled: true, twoFactorSecret: TOTP, twoFactorLastAcceptedStep: null } });
    const code = generateTotpToken(TOTP);
    expect(await consumeTotpToken(ids.user, TOTP, code)).toBe(true);
    const row = await raw.user.findUniqueOrThrow({ where: { id: ids.user } });
    expectSealed(row.twoFactorSecret, "user.twoFactorSecret", TOTP);
    // replay of the same code with the old stored string fails (CAS on the stored value + step)
    expect(await consumeTotpToken(ids.user, TOTP, code)).toBe(false);
    expect(await consumeTotpToken(ids.user, row.twoFactorSecret!, code)).toBe(false);
  });
});

describe("forged or foreign envelopes are plaintext (authenticate before preserving)", () => {
  const FORGED = `ff2.deadbeef.${"A".repeat(16)}.${"B".repeat(30)}`;

  it("notification tokens: a forged envelope and another column's ciphertext read back as submitted", async () => {
    const foreign = sealSecret("feed.authPassword", S.password); // valid ciphertext, wrong column
    await updateNotificationChannels({ gotifyToken: FORGED, ntfyToken: foreign });
    const row = await raw.user.findUniqueOrThrow({ where: { id: ids.user } });
    expect(row.gotifyToken).not.toBe(FORGED);
    expect(row.ntfyToken).not.toBe(foreign);
    expectSealed(row.gotifyToken, "user.gotifyToken", FORGED);
    expectSealed(row.ntfyToken, "user.ntfyToken", foreign);
  });

  it("feed credentials (updateFeed): forged envelope / cross-column copy are sealed literals", async () => {
    const foreign = sealSecret("user.gotifyToken", "S3CRET-other-column");
    await updateFeed(ids.feed, { authType: "basic", authUsername: FORGED, authPassword: foreign });
    const row = await raw.feed.findUniqueOrThrow({ where: { id: ids.feed } });
    expect(readFeedCredentials(row)).toMatchObject({ authUsername: FORGED, authPassword: foreign });
  });

  it("webhook JSON (createAutoReadRule): forged secret / foreign header are sealed literals", async () => {
    const foreign = sealSecret("feed.authPassword", S.password);
    const created = await createAutoReadRule({
      name: "forged", query: "x", actions: ["webhook_call:0"],
      webhookConfigs: [{ url: "https://hook.example/f", secret: FORGED, headers: { Authorization: foreign } }],
    });
    const stored = (await raw.autoReadRule.findUniqueOrThrow({ where: { id: created.id } })).webhookConfigs!;
    expect(getWebhookConfig({ webhookConfigs: stored }, 0)).toMatchObject({ secret: FORGED, headers: { Authorization: foreign } });
    await raw.autoReadRule.delete({ where: { id: created.id } });
  });

  it("admin connector key and v1 columns: a fake v1 / foreign v2 value is sealed as plaintext", async () => {
    state.session = { user: { id: ids.admin } };
    const fakeV1 = "AAAA:BBBB:CCCC";
    await updateGlobalSettings({ rsshubApiKey: fakeV1, smtpPassword: sealSecret("user.aiApiKey", "S3CRET-x") });
    const row = await raw.globalSettings.findUniqueOrThrow({ where: { id: "global" } });
    expect(openSecret("globalSettings.rsshubApiKey", row.rsshubApiKey!, "v1").value).toBe(fakeV1);
    expect(isV2(row.smtpPassword!)).toBe(true);
    expect(openSecret("globalSettings.smtpPassword", row.smtpPassword!, "v1").value).toMatch(/^ff2\./);
  });

  it("a value sealed for the same column under an unknown key is not preserved", () => {
    process.env.FEEDFERRET_ENCRYPTION_KEY = KEY_A;
    const underA = sealSecret("user.gotifyToken", "S3CRET-a");
    process.env.FEEDFERRET_ENCRYPTION_KEY = KEY_B;
    const out = sealWriteArgs("User", "update", { data: { gotifyToken: underA } }) as { data: { gotifyToken: string } };
    expect(out.data.gotifyToken).not.toBe(underA);
    expect(openSecret("user.gotifyToken", out.data.gotifyToken, "plaintext").value).toBe(underA);
    // with KEY_A configured as old key it authenticates and is kept verbatim
    process.env.FEEDFERRET_ENCRYPTION_KEYS_OLD = KEY_A;
    expect((sealWriteArgs("User", "update", { data: { gotifyToken: underA } }) as { data: { gotifyToken: string } }).data.gotifyToken).toBe(underA);
  });
});

describe("AAD and keys", () => {
  it("a value moved to another column does not decrypt", () => {
    const sealed = sealSecret("feed.authPassword", S.password);
    expect(() => openSecret("user.gotifyToken", sealed, "plaintext")).toThrow(SecretKeyError);
    expect(() => openSecret("feed.authPassword", sealed, "plaintext")).not.toThrow();
  });

  it("the wrong key fails closed with a typed error and never yields plaintext", () => {
    process.env.FEEDFERRET_ENCRYPTION_KEY = KEY_A;
    const sealed = sealSecret("user.aiApiKey", S.ai);
    process.env.FEEDFERRET_ENCRYPTION_KEY = KEY_B;
    let error: unknown;
    try {
      openSecret("user.aiApiKey", sealed, "v1");
    } catch (e) {
      error = e;
    }
    expect(error).toBeInstanceOf(SecretKeyError);
    expect((error as SecretKeyError).reason).toBe("unknown-kid");
    expectNoPlaintext(String(error));
  });
});

describe("migration (secrets:migrate / secrets:rotate core)", () => {
  async function seedLegacy() {
    await raw.user.update({
      where: { id: ids.user },
      data: { gotifyToken: S.gotify, aiApiKey: encrypt(S.ai), ntfyToken: null, telegramBotToken: null },
    });
    await raw.feed.update({ where: { id: ids.feed }, data: { authPassword: S.password, authUsername: null, httpOptions: null } });
    const rule = await raw.autoReadRule.create({
      data: { userId: ids.user, name: "legacy", query: "x", action: "webhook_call:0", actions: "webhook_call:0", webhookConfigs: JSON.stringify([{ url: "https://h.example", secret: S.webhook, headers: { Authorization: S.header } }]) },
    });
    return rule.id;
  }

  it("re-seals plaintext / v1 / JSON, is idempotent, dry-run writes nothing, keeps updatedAt", async () => {
    const ruleId = await seedLegacy();
    const before = await raw.user.findUniqueOrThrow({ where: { id: ids.user } });
    const keyring = loadKeyring(process.env);

    const dry = await migrateSecrets(raw, { keyring, mode: "migrate", dryRun: true, batchSize: 1 });
    expect(dry.totals.resealed).toBeGreaterThanOrEqual(4);
    expect((await raw.user.findUniqueOrThrow({ where: { id: ids.user } })).gotifyToken).toBe(S.gotify);

    const first = await migrateSecrets(raw, { keyring, mode: "migrate", batchSize: 1 });
    expect(first.totals.resealed).toBe(dry.totals.resealed);
    expect(first.totals.undecryptable).toBe(0);
    expectNoPlaintext(first);

    const after = await raw.user.findUniqueOrThrow({ where: { id: ids.user } });
    expectSealed(after.gotifyToken, "user.gotifyToken", S.gotify);
    expectSealed(after.aiApiKey, "user.aiApiKey", S.ai);
    expect(after.updatedAt.getTime()).toBe(before.updatedAt.getTime());
    expectSealed((await raw.feed.findUniqueOrThrow({ where: { id: ids.feed } })).authPassword, "feed.authPassword", S.password);
    const json = (await raw.autoReadRule.findUniqueOrThrow({ where: { id: ruleId } })).webhookConfigs!;
    expectNoPlaintext(json);
    expect(getWebhookConfig({ webhookConfigs: json }, 0)).toMatchObject({ secret: S.webhook, headers: { Authorization: S.header } });

    const second = await migrateSecrets(raw, { keyring, mode: "migrate" });
    expect(second.totals.resealed).toBe(0);
    expect(second.totals.current).toBe(first.totals.scanned);
    await raw.autoReadRule.delete({ where: { id: ruleId } });
  });

  it("rotate moves old-key values to the new key; migrate only reports them", async () => {
    process.env.FEEDFERRET_ENCRYPTION_KEY = KEY_A;
    await state.db.user.update({ where: { id: ids.user }, data: { gotifyToken: S.gotify } }); // sealed under A
    const kidA = v2KeyId((await raw.user.findUniqueOrThrow({ where: { id: ids.user } })).gotifyToken!);

    // AUTH_SECRET-derived values from the tests above are old-key values too
    process.env.FEEDFERRET_ENCRYPTION_KEY = KEY_B;
    process.env.FEEDFERRET_ENCRYPTION_KEYS_OLD = `${KEY_A},${AUTH}`;
    const keyring = loadKeyring(process.env);
    expect(keyring.old.map((k) => k.kid)).toContain(kidA);

    const migrate = await migrateSecrets(raw, { keyring, mode: "migrate" });
    expect(migrate.columns.find((c) => c.column === "user.gotifyToken")!.oldKey).toBe(1);
    expect(v2KeyId((await raw.user.findUniqueOrThrow({ where: { id: ids.user } })).gotifyToken!)).toBe(kidA);

    const rotate = await migrateSecrets(raw, { keyring, mode: "rotate" });
    expect(rotate.totals.undecryptable).toBe(0);
    expect(rotate.totals.resealed).toBeGreaterThanOrEqual(1);
    const stored = (await raw.user.findUniqueOrThrow({ where: { id: ids.user } })).gotifyToken!;
    expect(v2KeyId(stored)).toBe(keyring.current.kid);

    // the old keys can now be removed: everything is under KEY_B
    delete process.env.FEEDFERRET_ENCRYPTION_KEYS_OLD;
    expect(openSecret("user.gotifyToken", stored, "plaintext").value).toBe(S.gotify);
    const after = await migrateSecrets(raw, { keyring: loadKeyring(process.env), mode: "rotate" });
    expect(after.totals.resealed).toBe(0);
    expect(after.totals.undecryptable).toBe(0);

    // rotate back to the AUTH_SECRET-derived key for the following tests
    delete process.env.FEEDFERRET_ENCRYPTION_KEY;
    process.env.FEEDFERRET_ENCRYPTION_KEYS_OLD = KEY_B;
    expect((await migrateSecrets(raw, { keyring: loadKeyring(process.env), mode: "rotate" })).totals.undecryptable).toBe(0);
  });

  it("an undecryptable row is counted with a shortened id, never throws, never logs the value", async () => {
    process.env.FEEDFERRET_ENCRYPTION_KEY = KEY_A;
    const foreign = sealV2("user.ntfyToken", S.ntfy, loadKeyring(process.env));
    delete process.env.FEEDFERRET_ENCRYPTION_KEY; // KEY_A is not configured any more
    await raw.user.update({ where: { id: ids.user }, data: { ntfyToken: foreign } });
    const report = await migrateSecrets(raw, { keyring: loadKeyring(process.env), mode: "rotate" });
    expect(report.totals.undecryptable).toBe(1);
    expect(report.problems).toEqual([{ column: "user.ntfyToken", id: redactId(ids.user), reason: "unknown-kid" }]);
    expect(redactId(ids.user)).not.toBe(ids.user);
    expect((await raw.user.findUniqueOrThrow({ where: { id: ids.user } })).ntfyToken).toBe(foreign);
    expectNoPlaintext(report);

    // boot job: same, plus SystemLog + admin state, never throws
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const info = vi.spyOn(console, "info").mockImplementation(() => undefined);
    const boot = await runSecretMigration(raw);
    expect(boot?.totals.undecryptable).toBe(1);
    expect(getSecretMigrationState().last?.totals.undecryptable).toBe(1);
    const log = await raw.systemLog.findFirstOrThrow({ where: { category: "security" }, orderBy: { createdAt: "desc" } });
    expect(log.level).toBe("warn");
    expectNoPlaintext([log, warn.mock.calls, info.mock.calls]);
    expect(JSON.stringify(warn.mock.calls)).toContain("user.ntfyToken");
    warn.mockRestore();
    info.mockRestore();
    await raw.user.update({ where: { id: ids.user }, data: { ntfyToken: null } });
  });

  it("a concurrent write wins over the re-seal (CAS)", async () => {
    await raw.user.update({ where: { id: ids.user }, data: { gotifyToken: S.gotify } });
    const keyring = loadKeyring(process.env);
    // simulate: the user saves a new token between the migration's read and write
    const original = raw.user.updateMany.bind(raw.user);
    let raced = false;
    const spy = vi.spyOn(raw.user, "updateMany").mockImplementation((async (args: Parameters<typeof original>[0]) => {
      if (!raced) {
        raced = true;
        await state.db.user.update({ where: { id: ids.user }, data: { gotifyToken: "S3CRET-new" } });
      }
      return original(args);
    }) as never);
    const report = await migrateSecrets(raw, { keyring, mode: "migrate", columns: SECRET_COLUMNS.filter((c) => c.column === "gotifyToken"), clearOAuthTokens: false });
    spy.mockRestore();
    expect(report.totals.conflicts).toBe(1);
    expectSealed((await raw.user.findUniqueOrThrow({ where: { id: ids.user } })).gotifyToken, "user.gotifyToken", "S3CRET-new");
  });

  it("CAS includes the observed updatedAt: a concurrent edit of another column wins and is not rewound", async () => {
    await raw.user.update({ where: { id: ids.user }, data: { gotifyToken: S.gotify } });
    const keyring = loadKeyring(process.env);
    const only = SECRET_COLUMNS.filter((c) => c.column === "gotifyToken");
    const original = raw.user.updateMany.bind(raw.user);
    let edited: Date | null = null;
    const spy = vi.spyOn(raw.user, "updateMany").mockImplementation((async (args: Parameters<typeof original>[0]) => {
      if (!edited) {
        await new Promise((resolve) => setTimeout(resolve, 5));
        edited = (await raw.user.update({ where: { id: ids.user }, data: { name: "edited concurrently" } })).updatedAt;
      }
      return original(args);
    }) as never);
    const report = await migrateSecrets(raw, { keyring, mode: "migrate", columns: only, clearOAuthTokens: false });
    spy.mockRestore();
    expect(report.totals.conflicts).toBe(1);
    const row = await raw.user.findUniqueOrThrow({ where: { id: ids.user } });
    expect(row.name).toBe("edited concurrently");
    expect(row.updatedAt.getTime()).toBe(edited!.getTime()); // not rewound
    expect(row.gotifyToken).toBe(S.gotify); // retried next pass
    const next = await migrateSecrets(raw, { keyring, mode: "migrate", columns: only, clearOAuthTokens: false });
    expect(next.totals.resealed).toBe(1);
    const after = await raw.user.findUniqueOrThrow({ where: { id: ids.user } });
    expectSealed(after.gotifyToken, "user.gotifyToken", S.gotify);
    expect(after.updatedAt.getTime()).toBe(edited!.getTime());
  });

  it("clears unused OAuth account tokens", async () => {
    await raw.account.create({ data: { userId: ids.user, type: "oauth", provider: "github", providerAccountId: "1", access_token: "S3CRET-at", refresh_token: "S3CRET-rt" } });
    const report = await migrateSecrets(raw, { keyring: loadKeyring(process.env), mode: "migrate" });
    expect(report.oauthTokensCleared).toBe(1);
    const account = await raw.account.findFirstOrThrow({ where: { userId: ids.user } });
    expect(account.access_token).toBeNull();
    expect(account.refresh_token).toBeNull();
  });

  it("CLI migrate/rotate print counts only", async () => {
    await raw.user.update({ where: { id: ids.user }, data: { gotifyToken: S.gotify } });
    const out: string[] = [];
    const log = vi.spyOn(console, "log").mockImplementation((...args: unknown[]) => void out.push(args.map(String).join(" ")));
    const table = vi.spyOn(console, "table").mockImplementation((rows: unknown) => void out.push(JSON.stringify(rows)));
    expect(await secretsCli(["migrate", "--dry-run"])).toBe(0);
    expect((await raw.user.findUniqueOrThrow({ where: { id: ids.user } })).gotifyToken).toBe(S.gotify);
    expect(await secretsCli(["rotate", "--json"])).toBe(0);
    expect(await secretsCli(["migrate", "--batch", "0"]).catch((e: Error) => e.message)).toMatch(/--batch/);
    log.mockRestore();
    table.mockRestore();
    expectNoPlaintext(out);
    expect(out.join("\n")).toContain("would re-seal");
    expectSealed((await raw.user.findUniqueOrThrow({ where: { id: ids.user } })).gotifyToken, "user.gotifyToken", S.gotify);
  });
});

describe("signed tokens", () => {
  it("new GReader tokens / Telegram links use the derived key; legacy ones verify until FEEDFERRET_LEGACY_MAC_UNTIL", () => {
    const token = createGReaderToken("user-1", 2);
    const legacySig = createHmac("sha256", AUTH).update("user-1:2").digest("hex");
    expect(token).not.toBe(`user-1.2.${legacySig}`);
    expect(verifyGReaderToken(token)).toBe("user-1");
    expect(verifyGReaderToken(`user-1.2.${legacySig}`)).toBe("user-1");
    process.env.FEEDFERRET_LEGACY_MAC_UNTIL = "2000-01-01";
    expect(verifyGReaderToken(`user-1.2.${legacySig}`)).toBeNull();
    expect(verifyGReaderToken(token)).toBe("user-1");

    const p = new URL(generateMarkReadUrl("a", "u", "https://ff.example")).searchParams;
    expect(verifyMarkReadUrl("a", "u", p.get("exp")!, p.get("sig")!)).toBe(true);
    // after a key switch with the old key in _OLD, issued tokens keep verifying
    delete process.env.FEEDFERRET_LEGACY_MAC_UNTIL;
    process.env.FEEDFERRET_ENCRYPTION_KEY = KEY_B;
    process.env.FEEDFERRET_ENCRYPTION_KEYS_OLD = AUTH;
    expect(verifyGReaderToken(token)).toBe("user-1");
  });

  it("core openSecret rejects a v2 value from another column (purpose = AAD)", () => {
    const keyring = loadKeyring(process.env);
    const sealed = sealV2("globalSettings.smtpPassword", S.smtp, keyring);
    expect(() => openCore("globalSettings.resendApiKey", sealed, { legacy: "v1", keyring })).toThrow(/cannot be decrypted/);
  });
});
