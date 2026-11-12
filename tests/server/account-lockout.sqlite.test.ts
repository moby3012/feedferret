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
vi.mock("next-auth", () => ({
  default: (config: never) => { h.config = config; return { handlers: {}, auth: vi.fn(), signIn: vi.fn(), signOut: vi.fn() }; },
  CredentialsSignin: class CredentialsSignin extends Error { code = "credentials"; },
}));
vi.mock("next-auth/providers/credentials", () => ({ default: (options: unknown) => options }));
vi.mock("next-auth/providers/nodemailer", () => ({ default: (options: unknown) => options }));
vi.mock("@auth/prisma-adapter", () => ({ PrismaAdapter: () => ({}) }));
vi.mock("@/lib/mail", () => ({ sendSignInEmail: vi.fn() }));

import { BCRYPT_COST, DUMMY_PASSWORD_HASH } from "../../lib/password-hash";
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
    for (let i = 0; i < LIMIT; i++) expect(await reserveLoginAttempt(u.id, "web", new Date(t0.getTime() + i * 1000))).not.toBeNull();
    const end = (await state(u.id)).failedLoginWindowEnd!;
    expect(end.getTime()).toBe(t0.getTime() + ACCOUNT_LOCKOUT.windowMs);
    expect(await reserveLoginAttempt(u.id, "web", new Date(t0.getTime() + 60_000))).toBeNull();
    expect(await reserveLoginAttempt(u.id, "web", new Date(t0.getTime() + ACCOUNT_LOCKOUT.windowMs - 1))).toBeNull();
    expect((await state(u.id)).failedLoginWindowEnd!.getTime()).toBe(end.getTime());
    // window over → fresh budget
    expect(await reserveLoginAttempt(u.id, "web", new Date(end.getTime() + 1))).not.toBeNull();
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
    let token: Date | null = null;
    for (let i = 0; i < LIMIT; i++) token = await reserveLoginAttempt(a.id);
    expect(await reserveLoginAttempt(a.id)).toBeNull();
    await releaseLoginAttempt(a.id, "web", token);
    expect(await reserveLoginAttempt(a.id)).not.toBeNull();
    const tb = await reserveLoginAttempt(b.id);
    expect(tb).not.toBeNull();
    await releaseLoginAttempt(b.id, "web", tb); await releaseLoginAttempt(b.id, "web", tb);
    expect((await state(b.id)).failedLoginCount).toBe(0);
  });

  it("a refund is bound to the window it was reserved in: a success reserved before a rollover cannot decrement the next window", async () => {
    const u = await makeUser();
    const t0 = new Date("2031-01-01T00:00:00Z");
    const slow = await reserveLoginAttempt(u.id, "web", t0); // a slow sign-in (bcrypt, 2FA) starts here...
    expect(slow?.getTime()).toBe(t0.getTime() + ACCOUNT_LOCKOUT.windowMs);
    // ...and the window rolls over before it finishes: the next window already holds LIMIT attempts.
    const t1 = new Date(slow!.getTime() + 1);
    let fresh: Date | null = null;
    for (let i = 0; i < LIMIT; i++) fresh = await reserveLoginAttempt(u.id, "web", t1);
    expect(fresh!.getTime()).toBe(t1.getTime() + ACCOUNT_LOCKOUT.windowMs);
    expect(fresh!.getTime()).not.toBe(slow!.getTime());
    await releaseLoginAttempt(u.id, "web", slow); // late refund of the old window's attempt
    expect((await state(u.id)).failedLoginCount).toBe(LIMIT);
    expect(await reserveLoginAttempt(u.id, "web", t1)).toBeNull(); // still locked: no extra guess
    await releaseLoginAttempt(u.id, "web", fresh); // a refund inside the running window still works
    expect((await state(u.id)).failedLoginCount).toBe(LIMIT - 1);
    await releaseLoginAttempt(u.id, "web", null); // no token (locked / build) = no refund
    expect((await state(u.id)).failedLoginCount).toBe(LIMIT - 1);
  });

  it("parallel reservations around a rollover are each charged to exactly one window", async () => {
    const u = await makeUser();
    const t0 = new Date("2032-01-01T00:00:00Z");
    for (let i = 0; i < LIMIT; i++) await reserveLoginAttempt(u.id, "web", t0);
    const later = new Date(t0.getTime() + ACCOUNT_LOCKOUT.windowMs + 5);
    const results = await Promise.all(Array.from({ length: 30 }, () => reserveLoginAttempt(u.id, "web", later)));
    expect(results.filter(Boolean)).toHaveLength(LIMIT);
    expect(new Set(results.filter(Boolean).map((d) => d!.getTime())).size).toBe(1);
    expect((await state(u.id)).failedLoginCount).toBe(LIMIT);
  });

  it("survives a restart: a fresh client and an empty process still see the lockout", async () => {
    const u = await makeUser();
    for (let i = 0; i < LIMIT; i++) await reserveLoginAttempt(u.id);
    const before = h.db;
    await before.$disconnect();
    h.db = open(); // new process, new connection; the in-memory IP limiter is gone too
    vi.resetModules();
    const fresh = await import("../../lib/account-lockout");
    expect(await fresh.reserveLoginAttempt(u.id)).toBeNull();
  });

  it("CLEAR_LOGIN_LOCKOUT unlocks", async () => {
    const u = await makeUser();
    for (let i = 0; i < LIMIT; i++) await reserveLoginAttempt(u.id);
    await h.db.user.update({ where: { id: u.id }, data: CLEAR_LOGIN_LOCKOUT });
    expect(await reserveLoginAttempt(u.id)).not.toBeNull();
  });
});

describe("API scope and operator unlock", () => {
  it("the GReader/Fever counter is independent of the web sign-in counter", async () => {
    const u = await makeUser();
    for (let i = 0; i < LIMIT; i++) expect(await reserveLoginAttempt(u.id, "api")).not.toBeNull();
    expect(await reserveLoginAttempt(u.id, "api")).toBeNull();
    expect(await reserveLoginAttempt(u.id, "web")).not.toBeNull(); // the owner can still sign in
    const apiEnd = (await h.db.user.findUniqueOrThrow({ where: { id: u.id }, select: { failedApiLoginWindowEnd: true } })).failedApiLoginWindowEnd;
    await releaseLoginAttempt(u.id, "api", apiEnd);
    expect(await reserveLoginAttempt(u.id, "api")).not.toBeNull();
  });

  it("`auth-cli unlock-user` clears both lockouts (case-insensitive lookup) and reports unknown users", async () => {
    const u = await makeUser();
    for (let i = 0; i < LIMIT; i++) { await reserveLoginAttempt(u.id, "web"); await reserveLoginAttempt(u.id, "api"); }
    expect(await reserveLoginAttempt(u.id, "web")).toBeNull();
    vi.stubEnv("DATABASE_PROVIDER", "sqlite");
    vi.stubEnv("DATABASE_URL", `file:${dbFile}`);
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    const { main } = await import("../../scripts/auth-cli.mjs");
    expect(await main(["unlock-user", u.email!.toUpperCase().replace("@EXAMPLE.ORG", "@example.org")])).toBe(0);
    expect(await main(["unlock-user", "--user", "nobody@example.org"])).toBe(1);
    expect(await main(["unlock-user"])).toBe(1);
    log.mockRestore(); err.mockRestore(); vi.unstubAllEnvs();
    expect(await state(u.id)).toMatchObject({ failedLoginCount: 0, failedLoginWindowEnd: null });
    expect(await reserveLoginAttempt(u.id, "web")).not.toBeNull();
    expect(await reserveLoginAttempt(u.id, "api")).not.toBeNull();
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
    expect(await reserveLoginAttempt(u.id)).toBeNull();
  });

  it("unknown addresses and passwordless accounts consume no account budget", async () => {
    const u = await makeUser({ password: null });
    const signIn = authorize();
    expect(await signIn("nobody@example.org", "x", "203.0.113.9")).toBeNull();
    expect(await signIn(u.email!, "x", "203.0.113.9")).toBeNull();
    expect((await state(u.id)).failedLoginCount).toBe(0);
  });

  it("unknown and passwordless addresses cost one bcrypt verification and hit the same lockout as real accounts", async () => {
    const passwordless = await makeUser({ password: null });
    const real = await makeUser();
    const signIn = authorize();
    const compare = vi.spyOn(bcrypt, "compare");
    for (const email of ["ghost-a@example.org", passwordless.email!, real.email!]) {
      compare.mockClear();
      for (let i = 0; i < LIMIT; i++) expect(await signIn(email, "wrong", `203.0.113.${20 + i}`)).toBeNull();
      expect(compare).toHaveBeenCalledTimes(LIMIT); // every attempt paid for one verification
      compare.mockClear();
      // the 11th attempt is refused before any bcrypt work, for the real, the passwordless and the invented address alike
      expect(await signIn(email, "wrong", "198.51.100.77")).toBeNull();
      expect(compare).not.toHaveBeenCalled();
    }
    // lockout of an invented address is keyed by the address (case/whitespace-insensitive), not by IP
    expect(await signIn(" GHOST-A@example.org ", "wrong", "198.51.100.78")).toBeNull();
    expect(compare).not.toHaveBeenCalled();
    // a different invented address still gets its own budget
    expect(await signIn("ghost-b@example.org", "wrong", "198.51.100.77")).toBeNull();
    expect(compare).toHaveBeenCalledTimes(1);
    // refused attempts of invented addresses write no audit row, like a locked account
    expect(await h.db.loginAttempt.count({ where: { email: "ghost-a@example.org" } })).toBe(LIMIT);
  }, 60_000); // 10+ cost-12 dummy verifications

  it("2FA: a correct password without a code asks for it (and is not charged); a wrong password stays an anonymous failure", async () => {
    const u = await makeUser({ twoFactorEnabled: true, twoFactorSecret: "JBSWY3DPEHPK3PXP" });
    const signIn = authorize();
    await expect(signIn(u.email!, "correct horse", "203.0.113.200")).rejects.toMatchObject({ code: "otp_required" });
    expect((await state(u.id)).failedLoginCount).toBe(0);
    for (let i = 0; i < 3 * LIMIT; i++) await expect(signIn(u.email!, "correct horse", "203.0.113.201")).rejects.toMatchObject({ code: "otp_required" });
    expect((await state(u.id)).failedLoginCount).toBe(0); // asking for the code is not a guess
    expect(await signIn(u.email!, "wrong", "203.0.113.202")).toBeNull(); // no hint that the account exists / has 2FA
    expect(await signIn(u.email!, "wrong", "203.0.113.202", "000000")).toBeNull();
    expect((await state(u.id)).failedLoginCount).toBe(2);
    // a locked account refuses without revealing anything either
    for (let i = 0; i < LIMIT; i++) await reserveLoginAttempt(u.id);
    expect(await signIn(u.email!, "correct horse", "203.0.113.203")).toBeNull();
  });

  it("the dummy hash costs exactly what real hashes cost", () => {
    expect(bcrypt.getRounds(DUMMY_PASSWORD_HASH)).toBe(BCRYPT_COST);
    expect(bcrypt.compareSync("not the password", DUMMY_PASSWORD_HASH)).toBe(false);
  });

  it("a successful sign-in moves an older-cost hash to the current cost; a failed one leaves it alone", async () => {
    const old = await bcrypt.hash("correct horse", 4); // another cost than BCRYPT_COST
    const u = await makeUser({ password: old });
    const signIn = authorize();
    expect(await signIn(u.email!, "wrong", "203.0.113.150")).toBeNull();
    expect((await h.db.user.findUniqueOrThrow({ where: { id: u.id } })).password).toBe(old);
    expect(await signIn(u.email!, "correct horse", "203.0.113.151")).toMatchObject({ id: u.id });
    const after = (await h.db.user.findUniqueOrThrow({ where: { id: u.id } })).password!;
    expect(bcrypt.getRounds(after)).toBe(BCRYPT_COST);
    expect(await bcrypt.compare("correct horse", after)).toBe(true);
    expect(await signIn(u.email!, "correct horse", "203.0.113.152")).toMatchObject({ id: u.id }); // still works, no further rehash
    expect((await h.db.user.findUniqueOrThrow({ where: { id: u.id } })).password).toBe(after);
  }, 30_000);
});
