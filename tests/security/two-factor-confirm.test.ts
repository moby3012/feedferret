// confirmTwoFactorSetup only completes a PENDING setup: it is not a code-guessing oracle for an account
// that already has 2FA, it is rate limited, and enabling is bound to the pending secret it verified.
import { afterAll, beforeAll, beforeEach, expect, it, vi } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PrismaClient } from "@prisma/client";
import { PrismaBetterSqlite3 } from "@prisma/adapter-better-sqlite3";

const state = vi.hoisted(() => ({ db: null as unknown as PrismaClient, uid: "u0" }));
vi.mock("@/lib/db", () => ({ get db() { return state.db; } }));
vi.mock("@/auth", () => ({ auth: async () => ({ user: { id: state.uid }, authenticatedAt: Date.now() / 1000 }) }));
vi.mock("next-intl/server", () => ({ getTranslations: async () => (key: string) => key }));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
import { beginTwoFactorSetup, confirmTwoFactorSetup } from "@/app/actions/settings";
import { generateTotpToken } from "@/lib/totp";

const dir = mkdtempSync(join(tmpdir(), "two-factor-confirm-"));
const url = `file:${join(dir, "test.db")}`;
const LIVE_SECRET = "JBSWY3DPEHPK3PXPJBSWY3DPEHPK3PXP";
let n = 0;
const row = () => state.db.user.findUniqueOrThrow({ where: { id: state.uid }, select: { twoFactorEnabled: true, twoFactorSecret: true, sessionVersion: true, apiTokenVersion: true } });
// the limiter is per user id and process-wide, so every test gets its own account
beforeEach(async () => {
  state.uid = `u${++n}`;
  await state.db.user.create({ data: { id: state.uid, email: `${state.uid}@test.org` } });
});
beforeAll(() => {
  execFileSync("node_modules/.bin/prisma", ["db", "push"], { env: { ...process.env, DATABASE_PROVIDER: "sqlite", DATABASE_URL: url }, stdio: "pipe" });
  state.db = new PrismaClient({ adapter: new PrismaBetterSqlite3({ url }) });
}, 30000);
afterAll(async () => { await state.db.$disconnect(); rmSync(dir, { recursive: true, force: true }); });

it("enables 2FA for a pending setup with a valid code, and rejects a wrong one", async () => {
  const setup = await beginTwoFactorSetup();
  await expect(confirmTwoFactorSetup("000000")).rejects.toThrow("Invalid one-time code");
  expect(await row()).toMatchObject({ twoFactorEnabled: false, sessionVersion: 0 });
  await expect(confirmTwoFactorSetup(generateTotpToken(setup.secret))).resolves.toEqual({ enabled: true });
  expect(await row()).toMatchObject({ twoFactorEnabled: true, sessionVersion: 1, apiTokenVersion: 1 });
});

it("refuses an account that already has 2FA, even with the right code, without touching it (no OTP oracle)", async () => {
  await state.db.user.update({ where: { id: state.uid }, data: { twoFactorEnabled: true, twoFactorSecret: LIVE_SECRET } });
  await expect(confirmTwoFactorSetup(generateTotpToken(LIVE_SECRET))).rejects.toThrow("already enabled");
  for (let i = 0; i < 30; i++) await expect(confirmTwoFactorSetup(String(100000 + i))).rejects.toThrow("already enabled");
  expect(await row()).toMatchObject({ twoFactorEnabled: true, twoFactorSecret: LIVE_SECRET, sessionVersion: 0, apiTokenVersion: 0 });
});

it("needs a started setup", async () => {
  await expect(confirmTwoFactorSetup("123456")).rejects.toThrow("Start setup first");
});

it("throttles code guesses against a pending setup (10 per 15 minutes), and a limited user cannot enable with the right code either", async () => {
  const setup = await beginTwoFactorSetup();
  for (let i = 0; i < 10; i++) await expect(confirmTwoFactorSetup("000000")).rejects.toThrow("Invalid one-time code");
  await expect(confirmTwoFactorSetup("000000")).rejects.toThrow("twoFactorRateLimited");
  await expect(confirmTwoFactorSetup(generateTotpToken(setup.secret))).rejects.toThrow("twoFactorRateLimited");
  expect((await row()).twoFactorEnabled).toBe(false);
});

it("is bound to the pending secret: a code for a superseded setup does not enable the new one", async () => {
  const first = await beginTwoFactorSetup();
  const second = await beginTwoFactorSetup(); // restarted setup rotates the pending secret
  expect(second.secret).not.toBe(first.secret);
  await expect(confirmTwoFactorSetup(generateTotpToken(first.secret))).rejects.toThrow("Invalid one-time code");
  expect((await row()).twoFactorEnabled).toBe(false);
  await expect(confirmTwoFactorSetup(generateTotpToken(second.secret))).resolves.toEqual({ enabled: true });
});

it("two concurrent confirmations enable once (the second finds it already enabled / changed)", async () => {
  const setup = await beginTwoFactorSetup();
  const code = generateTotpToken(setup.secret);
  const results = await Promise.allSettled([confirmTwoFactorSetup(code), confirmTwoFactorSetup(code)]);
  expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
  expect(await row()).toMatchObject({ twoFactorEnabled: true, sessionVersion: 1, apiTokenVersion: 1 }); // bumped exactly once
});
