// Per-account sign-in lockout against a real SQLite database: attempts are reserved atomically, hold
// across IPs and across a "restart" (fresh client / empty in-memory limiter state), and the Credentials
// provider honours them. See lib/account-lockout.ts.
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { PrismaClient } from "@prisma/client";
import { PrismaBetterSqlite3 } from "@prisma/adapter-better-sqlite3";
import bcrypt from "bcryptjs";

const h = vi.hoisted(() => ({ db: null as unknown as PrismaClient, config: null as null | { providers: Array<{ authorize?: (c: Record<string, unknown>, req: Request) => Promise<unknown> }> } }));
vi.mock("@/lib/db", () => ({ get db() { return h.db; }, getDatabaseProvider: () => "sqlite" }));
vi.mock("next-auth", () => ({ default: (config: never) => { h.config = config; return { handlers: {}, auth: vi.fn(), signIn: vi.fn(), signOut: vi.fn() }; } }));
vi.mock("next-auth/providers/credentials", () => ({ default: (options: unknown) => options }));
vi.mock("next-auth/providers/nodemailer", () => ({ default: (options: unknown) => options }));
vi.mock("@auth/prisma-adapter", () => ({ PrismaAdapter: () => ({}) }));
vi.mock("@/lib/mail", () => ({ sendSignInEmail: vi.fn() }));

import { ACCOUNT_LOCKOUT, CLEAR_LOGIN_LOCKOUT, releaseLoginAttempt, reserveLoginAttempt } from "../../lib/account-lockout";

const dir = mkdtempSync(join(tmpdir(), "feedferret-account-lockout-"));
const dbFile = join(dir, "test.db");
const open = () => new PrismaClient({ adapter: new PrismaBetterSqlite3({ url: dbFile }) });
const LIMIT = ACCOUNT_LOCKOUT.limit;

beforeAll(async () => {
  execFileSync("node_modules/.bin/prisma", ["db", "push", "--schema", "prisma/schema.generated.prisma"], { env: { ...process.env, DATABASE_URL: `file:${dbFile}` }, stdio: "pipe" });
  h.db = open();
  process.env.AUTH_SECRET = "x".repeat(40);
  await import("../../auth");
}, 60_000);

afterAll(async () => {
  await h.db?.$disconnect();
  rmSync(dir, { recursive: true, force: true });
});

let n = 0;
async function makeUser(overrides: Record<string, unknown> = {}) {
  const id = `u${++n}`;
  const password = await bcrypt.hash("correct horse", 4);
  return h.db.user.create({ data: { id, email: `${id}@example.org`, password, ...overrides } });
}
const state = (id: string) => h.db.user.findUniqueOrThrow({ where: { id }, select: { failedLoginCount: true, failedLoginWindowEnd: true } });

describe("reserveLoginAttempt", () => {
  it("allows exactly `limit` attempts per window, then refuses without extending the window", async () => {
    const u = await makeUser();
    const t0 = new Date("2030-01-01T00:00:00Z");
    for (let i = 0; i < LIMIT; i++) expect(await reserveLoginAttempt(u.id, new Date(t0.getTime() + i * 1000))).toBe(true);
    const end = (await state(u.id)).failedLoginWindowEnd!;
    expect(end.getTime()).toBe(t0.getTime() + ACCOUNT_LOCKOUT.windowMs);
    expect(await reserveLoginAttempt(u.id, new Date(t0.getTime() + 60_000))).toBe(false);
    expect(await reserveLoginAttempt(u.id, new Date(t0.getTime() + ACCOUNT_LOCKOUT.windowMs - 1))).toBe(false);
    expect((await state(u.id)).failedLoginWindowEnd!.getTime()).toBe(end.getTime());
    // window over → fresh budget
    expect(await reserveLoginAttempt(u.id, new Date(end.getTime() + 1))).toBe(true);
    expect((await state(u.id)).failedLoginCount).toBe(1);
  });

  it("is atomic: parallel guesses cannot overshoot the limit", async () => {
    const u = await makeUser();
    const results = await Promise.all(Array.from({ length: 40 }, () => reserveLoginAttempt(u.id)));
    expect(results.filter(Boolean)).toHaveLength(LIMIT);
    expect((await state(u.id)).failedLoginCount).toBe(LIMIT);
  });

  it("a released attempt can be used again, never below zero; accounts are independent", async () => {
    const [a, b] = [await makeUser(), await makeUser()];
    for (let i = 0; i < LIMIT; i++) await reserveLoginAttempt(a.id);
    expect(await reserveLoginAttempt(a.id)).toBe(false);
    await releaseLoginAttempt(a.id);
    expect(await reserveLoginAttempt(a.id)).toBe(true);
    expect(await reserveLoginAttempt(b.id)).toBe(true);
    await releaseLoginAttempt(b.id); await releaseLoginAttempt(b.id);
    expect((await state(b.id)).failedLoginCount).toBe(0);
  });

  it("survives a restart: a fresh client and an empty process still see the lockout", async () => {
    const u = await makeUser();
    for (let i = 0; i < LIMIT; i++) await reserveLoginAttempt(u.id);
    const before = h.db;
    await before.$disconnect();
    h.db = open(); // new process, new connection; the in-memory IP limiter is gone too
    vi.resetModules();
    const fresh = await import("../../lib/account-lockout");
    expect(await fresh.reserveLoginAttempt(u.id)).toBe(false);
  });

  it("CLEAR_LOGIN_LOCKOUT unlocks", async () => {
    const u = await makeUser();
    for (let i = 0; i < LIMIT; i++) await reserveLoginAttempt(u.id);
    await h.db.user.update({ where: { id: u.id }, data: CLEAR_LOGIN_LOCKOUT });
    expect(await reserveLoginAttempt(u.id)).toBe(true);
  });
});

describe("Credentials provider", () => {
  const authorize = () => {
    const provider = h.config!.providers.find((p) => typeof p.authorize === "function")!;
    return (email: string, password: string, ip: string, otp?: string) =>
      provider.authorize!({ email, password, otp }, new Request("https://example.test/api/auth/callback/credentials", { method: "POST", headers: { "x-forwarded-for": ip } }));
  };
  beforeEach(() => { vi.spyOn(console, "warn").mockImplementation(() => {}); });

  it("locks the account after 10 wrong passwords from 10 different IPs, even for the right password", async () => {
    const u = await makeUser();
    const signIn = authorize();
    for (let i = 0; i < LIMIT; i++) expect(await signIn(u.email!, "wrong", `203.0.113.${i + 1}`)).toBeNull();
    const compare = vi.spyOn(bcrypt, "compare");
    expect(await signIn(u.email!, "correct horse", "198.51.100.1")).toBeNull(); // a never-seen IP
    expect(compare).not.toHaveBeenCalled(); // refused before any password check
    const rows = await h.db.loginAttempt.count({ where: { userId: u.id } });
    expect(rows).toBe(LIMIT); // the refused attempt wrote no audit row
  });

  it("a successful sign-in gives its attempt back; other accounts are unaffected", async () => {
    const [a, b] = [await makeUser(), await makeUser()];
    const signIn = authorize();
    for (let i = 0; i < LIMIT - 1; i++) await signIn(a.email!, "wrong", "203.0.113.50");
    expect(await signIn(a.email!, "correct horse", "203.0.113.51")).toMatchObject({ id: a.id });
    expect((await state(a.id)).failedLoginCount).toBe(LIMIT - 1);
    expect(await signIn(b.email!, "correct horse", "203.0.113.52")).toMatchObject({ id: b.id });
    expect((await state(b.id)).failedLoginCount).toBe(0);
  });

  it("wrong 2FA codes after a correct password count too", async () => {
    const u = await makeUser({ twoFactorEnabled: true, twoFactorSecret: "JBSWY3DPEHPK3PXP" });
    const signIn = authorize();
    for (let i = 0; i < LIMIT; i++) expect(await signIn(u.email!, "correct horse", `203.0.113.${100 + i}`, "000000")).toBeNull();
    expect(await reserveLoginAttempt(u.id)).toBe(false);
  });

  it("unknown addresses and passwordless accounts consume no account budget", async () => {
    const u = await makeUser({ password: null });
    const signIn = authorize();
    expect(await signIn("nobody@example.org", "x", "203.0.113.9")).toBeNull();
    expect(await signIn(u.email!, "x", "203.0.113.9")).toBeNull();
    expect((await state(u.id)).failedLoginCount).toBe(0);
  });
});
