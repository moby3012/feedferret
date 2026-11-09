import { afterAll, beforeAll, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { PrismaClient } from "@prisma/client";
import { PrismaBetterSqlite3 } from "@prisma/adapter-better-sqlite3";
const state = vi.hoisted(() => ({ db: null as unknown as PrismaClient }));
vi.mock("@/lib/db", () => ({ get db() { return state.db; } }));
vi.mock("@/lib/rate-limit", () => ({ checkRateLimit: () => ({ success: true }), getClientIdentifier: () => "test", RATE_LIMITS: { authSignIn: {} } }));
import { POST } from "../../app/api/register/route";
const dir = mkdtempSync(join(tmpdir(), "feedferret-registration-"));
beforeAll(() => {
  const url = `file:${join(dir, "test.db")}`;
  execFileSync("pnpm", ["exec", "prisma", "db", "push", "--schema", "prisma/schema.generated.prisma"], { env: { ...process.env, DATABASE_PROVIDER: "sqlite", DATABASE_URL: url }, stdio: "pipe" });
  state.db = new PrismaClient({ adapter: new PrismaBetterSqlite3({ url }) });
}, 30000);
afterAll(async () => { await state.db?.$disconnect(); rmSync(dir, { recursive: true, force: true }); });
it("two concurrent bootstrap registrations create exactly one admin", async () => {
  const request = (email: string) => new Request("https://example.test/api/register", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ name: "Admin", email, password: "StrongPass123!" }) });
  const responses = await Promise.all([POST(request("one@test.com")), POST(request("two@test.com"))]);
  expect(responses.map(r => r.status).sort()).toEqual([201, expect.toBeOneOf([403, 409])]);
  expect(await state.db.user.count({ where: { role: "ADMIN" } })).toBe(1);
  expect(await state.db.user.count()).toBe(1);
  expect(await state.db.globalSettings.findUnique({ where: { id: "global" } })).toMatchObject({ registrationsEnabled: false });
}, 30000);
