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
  // N12: the rate-limited 11th attempt writes no audit row.
  expect(mocks.log).toHaveBeenCalledTimes(10);
});
it("N6: parallel guesses are reserved before bcrypt, so at most `limit` compares run", async () => {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  mocks.compare.mockImplementation(async () => { await gate; return false; });
  const attempts = Array.from({ length: 30 }, (_, i) =>
    authenticateGReaderPassword(request(`parallel-${i}`), "parallel@test.com", `guess-${i}`));
  // Let every request get past its DB lookup while bcrypt is still pending.
  await new Promise((resolve) => setTimeout(resolve, 10));
  release();
  const results = await Promise.all(attempts);
  expect(results.every((result) => result === null)).toBe(true);
  expect(mocks.compare).toHaveBeenCalledTimes(RATE_LIMITS.authSignIn.limit);
});
it("N6: a correct password gives its reserved attempt back", async () => {
  mocks.compare.mockResolvedValue(false);
  for (let i = 0; i < RATE_LIMITS.authSignIn.limit - 1; i++) {
    await authenticateGReaderPassword(request(`refund-${i}`), "refund@test.com", "bad");
  }
  mocks.compare.mockResolvedValue(true);
  // Fresh user object each time so the verification cache does not short-cut bcrypt.
  for (let i = 0; i < 3; i++) {
    mocks.user.mockResolvedValueOnce({ ...user, id: `refund-user-${i}` });
    expect(await authenticateGReaderPassword(request(`refund-ok-${i}`), "refund@test.com", "pw")).not.toBeNull();
  }
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
