import { afterAll, afterEach, beforeAll, beforeEach, expect, it, vi } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PrismaClient } from "@prisma/client";
import { PrismaBetterSqlite3 } from "@prisma/adapter-better-sqlite3";

const state = vi.hoisted(() => ({ db: null as unknown as PrismaClient, mails: [] as Array<{ to: string; text: string }>, enabled: true, limited: false, failTo: "" }));
vi.mock("@/lib/db", () => ({ get db() { return state.db; } }));
vi.mock("@/lib/mail", () => ({ isMailServiceEnabled: async () => state.enabled, sendSystemEmail: vi.fn(async (mail) => { if (mail.to === state.failTo) throw new Error("SMTP failure"); state.mails.push(mail); }), sendEmailChangeNotices: async () => true }));
vi.mock("@/auth", () => ({ auth: async () => ({ user: { id: "u" }, authenticatedAt: Date.now() / 1000 }) }));
vi.mock("next-intl/server", () => ({ getTranslations: async () => (key: string) => key }));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("@/lib/step-up", () => ({ verifyStepUp: async () => ({ ok: true }) }));
vi.mock("@/lib/rate-limit", () => ({ checkRateLimit: (_key: string, options: { prefix: string }) => ({ success: !(state.limited && options.prefix === "email-change-request") }), RATE_LIMITS: {} }));
import { consumeEmailChange, hashEmailChangeToken, requestEmailChange } from "@/lib/email-change";
import { generateTotpToken } from "@/lib/totp";
import { redact } from "@/lib/redact";
import { updateProfile, changePassword, cancelPendingEmailChange, beginTwoFactorSetup, confirmTwoFactorSetup, disableTwoFactor } from "@/app/actions/settings";
import bcrypt from "bcryptjs";
const dir = mkdtempSync(join(tmpdir(), "email-change-"));
const url = `file:${join(dir, "test.db")}`;
const token = () => state.mails.find(m => m.to === "new@test.org")!.text.match(/\?t=([a-f0-9]+)/)![1];
const cancel = () => state.mails.find(m => m.to === "old@test.org")!.text.match(/\?c=([a-f0-9]+)/)![1];
beforeAll(() => {
  execFileSync("node_modules/.bin/prisma", ["db", "push"], { env: { ...process.env, DATABASE_PROVIDER: "sqlite", DATABASE_URL: url }, stdio: "pipe" });
  state.db = new PrismaClient({ adapter: new PrismaBetterSqlite3({ url }) });
}, 30000);
beforeEach(async () => {
  await state.db.user.deleteMany();
  await state.db.user.create({ data: { id: "u", email: "old@test.org", password: await bcrypt.hash("old-password", 4), apiFeverKey: "old-key" } });
  await state.db.apiToken.create({ data: { userId: "u", name: "test", tokenHash: "test-hash", feverKey: "fever-key" } });
  state.mails = []; state.enabled = true; state.limited = false; state.failTo = "";
});
afterEach(() => vi.unstubAllEnvs());
afterAll(async () => { await state.db.$disconnect(); rmSync(dir, { recursive: true, force: true }); });
it("requests through the authenticated action, hashes tokens and only changes identity on confirmation", async () => {
  expect(await updateProfile({ email: "NEW@test.org" })).toMatchObject({ success: true, emailChanged: false, emailPending: "new@test.org" });
  const pending = await state.db.emailChangeRequest.findUniqueOrThrow({ where: { userId: "u" } });
  expect(pending.tokenHash).toBe(hashEmailChangeToken(token()));
  expect(pending.cancelHash).toBe(hashEmailChangeToken(cancel()));
  expect((await state.db.user.findUniqueOrThrow({ where: { id: "u" } })).email).toBe("old@test.org");
  expect(await consumeEmailChange(token())).toBe("confirmed");
  expect(state.mails.at(-1)?.text).toContain("Nicht du? Ändere sofort dein Passwort");
  expect(await consumeEmailChange(token())).toBe("invalid");
  expect(await state.db.emailChangeRequest.count()).toBe(0);
  expect(await state.db.user.findUniqueOrThrow({ where: { id: "u" } })).toMatchObject({ email: "new@test.org", sessionVersion: 1, apiTokenVersion: 1, apiFeverKey: null, emailVerified: expect.any(Date) });
  expect((await state.db.apiToken.findFirstOrThrow()).feverKey).toBeNull();
});
it("expires, cancels with the old-address token, and replaces tokens on resend", async () => {
  await requestEmailChange("u", "old@test.org", "new@test.org", "de");
  const old = token();
  await requestEmailChange("u", "old@test.org", "new@test.org", "de");
  expect(await consumeEmailChange(old)).toBe("invalid");
  state.mails.splice(0, 2);
  expect(await consumeEmailChange(cancel(), true)).toBe("cancelled");
  expect(await state.db.user.findUniqueOrThrow({ where: { id: "u" } })).toMatchObject({ email: "old@test.org", sessionVersion: 1, apiTokenVersion: 1, apiFeverKey: null });
  expect((await state.db.apiToken.findFirstOrThrow()).feverKey).toBeNull();
  expect(await consumeEmailChange(token())).toBe("invalid");
  state.mails = [];
  await requestEmailChange("u", "old@test.org", "new@test.org", "de");
  await state.db.emailChangeRequest.updateMany({ data: { expiresAt: new Date(0) } });
  expect(await consumeEmailChange(token())).toBe("invalid");
});
it("rechecks case-insensitive uniqueness at confirmation", async () => {
  await requestEmailChange("u", "old@test.org", "new@test.org", "en");
  await state.db.user.create({ data: { email: "New@Test.Org" } });
  expect(await consumeEmailChange(token())).toBe("emailTaken");
});
it("rejects stale account identity and invalidates on password change or authenticated cancel", async () => {
  await requestEmailChange("u", "old@test.org", "new@test.org", "en");
  await state.db.user.update({ where: { id: "u" }, data: { email: "other@test.org" } });
  expect(await consumeEmailChange(token())).toBe("invalid");
  await changePassword({ currentPassword: "old-password", newPassword: "a-new-long-password-123" });
  expect(await state.db.emailChangeRequest.count()).toBe(0);
  await requestEmailChange("u", "other@test.org", "new@test.org", "en");
  await cancelPendingEmailChange();
  expect(await state.db.emailChangeRequest.count()).toBe(0);
});
it("keeps the immediate step-up path without mail", async () => {
  state.enabled = false;
  expect(await updateProfile({ email: "new@test.org" })).toMatchObject({ success: true, emailChanged: true });
  expect(await state.db.emailChangeRequest.count()).toBe(0);
});

it("limits request/resend independently of step-up", async () => {
  state.limited = true;
  expect(await updateProfile({ email: "new@test.org" })).toEqual({ success: false, code: "rateLimited" });
  expect(await state.db.emailChangeRequest.count()).toBe(0);
  expect(state.mails).toEqual([]);
});
it("only one of two pending accounts can confirm the same address", async () => {
  await state.db.user.create({ data: { id: "v", email: "v@test.org" } });
  await requestEmailChange("u", "old@test.org", "new@test.org", "en");
  const first = token();
  state.mails = [];
  await requestEmailChange("v", "v@test.org", "new@test.org", "en");
  const second = token();
  expect(await consumeEmailChange(first)).toBe("confirmed");
  expect(await consumeEmailChange(second)).toBe("emailTaken");
});

it("invalidates on 2FA setup, enable and disable", async () => {
  await requestEmailChange("u", "old@test.org", "new@test.org", "en");
  const setup = await beginTwoFactorSetup();
  expect(await state.db.emailChangeRequest.count()).toBe(0);
  await requestEmailChange("u", "old@test.org", "new@test.org", "en");
  await confirmTwoFactorSetup(generateTotpToken(setup.secret));
  expect(await state.db.emailChangeRequest.count()).toBe(0);
  await requestEmailChange("u", "old@test.org", "new@test.org", "en");
  await disableTwoFactor(generateTotpToken(setup.secret, Date.now() + 30_000)); // the setup code is spent: use the next step
  expect(await state.db.emailChangeRequest.count()).toBe(0);
});
it("redacts confirmation and cancellation links from diagnostics", () => {
  for (const key of ["t", "c"]) {
    expect(redact(`https://example.org/account/confirm-email?${key}=abc`)).not.toContain("abc");
    expect(redact(`https%3A%2F%2Fexample.org%2Faccount%2Fconfirm-email%3F${key}%3Dabc`)).not.toContain("abc");
  }
});
it("consumes a token only once under concurrent confirmation", async () => {
  await requestEmailChange("u", "old@test.org", "new@test.org", "en");
  const t = token();
  expect((await Promise.all([consumeEmailChange(t), consumeEmailChange(t)])).sort()).toEqual(["confirmed", "invalid"]);
  expect((await state.db.user.findUniqueOrThrow({ where: { id: "u" } })).sessionVersion).toBe(1);
});

it("refuses creation and preserves an existing request if the old-address notice fails", async () => {
  state.failTo = "old@test.org";
  expect(await updateProfile({ email: "new@test.org" })).toEqual({ success: false, code: "emailPendingSendFailed" });
  expect(await state.db.emailChangeRequest.count()).toBe(0);
  expect(state.mails).toEqual([]);
  state.failTo = "";
  await requestEmailChange("u", "old@test.org", "new@test.org", "en");
  const previous = await state.db.emailChangeRequest.findUniqueOrThrow({ where: { userId: "u" } });
  state.failTo = "old@test.org";
  await expect(requestEmailChange("u", "old@test.org", "other@test.org", "en")).rejects.toThrow("old-address security notice");
  expect((await state.db.emailChangeRequest.findUniqueOrThrow({ where: { userId: "u" } })).tokenHash).toBe(previous.tokenHash);
});
it("keeps a pending request with a failed delivery result if only the new-address mail fails", async () => {
  state.failTo = "new@test.org";
  expect(await updateProfile({ email: "new@test.org" })).toMatchObject({ success: true, emailPending: "new@test.org", emailNotice: "failed" });
  expect(await state.db.emailChangeRequest.count()).toBe(1);
  expect(state.mails[0].text).toContain("n***@test.org");
  expect(state.mails[0].text).not.toContain("new@test.org");
});
it("requires a configured public link base in production before sending or persisting anything", async () => {
  vi.stubEnv("NODE_ENV", "production"); vi.stubEnv("AUTH_URL", ""); vi.stubEnv("NEXT_PUBLIC_APP_URL", "");
  await expect(requestEmailChange("u", "old@test.org", "new@test.org", "de")).rejects.toThrow("AUTH_URL or NEXT_PUBLIC_APP_URL");
  expect(await state.db.emailChangeRequest.count()).toBe(0);
  expect(state.mails).toEqual([]);
});
it("leaves unrelated t/c query parameters visible", () => {
  for (const url of ["https://example.org/feed?t=123&c=456", "https%3A%2F%2Fexample.org%2Ffeed%3Ft%3D123%26c%3D456"]) expect(redact(url)).toBe(url);
  expect(redact("/account/confirm-email?x=1&t=secret&c=cancel&keep=yes")).toBe("/account/confirm-email?x=1&t=***&c=***&keep=yes");
});
