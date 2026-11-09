import { beforeEach, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({ user: vi.fn(), compare: vi.fn(), log: vi.fn() }));
vi.mock("@/lib/db", () => ({ db: { user: { findUnique: mocks.user }, loginAttempt: { create: mocks.log } } }));
vi.mock("bcryptjs", () => ({ default: { compare: mocks.compare } }));
vi.mock("@/lib/markdown-render", () => ({ renderMarkdownToHtml: vi.fn() }));
import { authenticateGReaderPassword } from "../../lib/greader";
import { checkRateLimit, RATE_LIMITS } from "../../lib/rate-limit";
const user = { id: "u1", password: "hash", isActive: true, twoFactorEnabled: false };
beforeEach(() => { vi.clearAllMocks(); mocks.user.mockResolvedValue(user); mocks.compare.mockResolvedValue(true); });
const request = (ip: string) => new Request("https://example.test", { headers: { "x-forwarded-for": ip } });
it("successful polling never consumes failed-attempt budgets or writes audit rows", async () => {
  for (let i = 0; i < 25; i++) expect(await authenticateGReaderPassword(request("success-ip"), "success@test.com", "pw")).toEqual(user);
  expect(mocks.log).not.toHaveBeenCalled();
});
it("counts failures per normalized email and stops before bcrypt", async () => {
  mocks.compare.mockResolvedValue(false);
  for (let i = 0; i < 10; i++) expect(await authenticateGReaderPassword(request(`failure-${i}`), "Failure@Test.com", "bad")).toBeNull();
  mocks.compare.mockResolvedValue(true);
  expect(await authenticateGReaderPassword(request("new-source"), "failure@test.com", "pw")).toBeNull();
  expect(mocks.compare).toHaveBeenCalledTimes(10);
  expect(mocks.log).toHaveBeenCalledTimes(11);
});
it("isolates GReader IP failures from web sign-in and blocks across emails", async () => {
  for (let i = 0; i < 12; i++) checkRateLimit("ip:separate", RATE_LIMITS.authSignIn);
  expect(await authenticateGReaderPassword(request("separate"), "separate@test.com", "pw")).toEqual(user);
  mocks.compare.mockResolvedValue(false);
  for (let i = 0; i < 10; i++) await authenticateGReaderPassword(request("separate"), `bad-${i}@test.com`, "bad");
  mocks.compare.mockClear();
  expect(await authenticateGReaderPassword(request("separate"), "other@test.com", "pw")).toBeNull();
  expect(mocks.compare).not.toHaveBeenCalled();
});
