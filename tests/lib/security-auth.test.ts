import { beforeEach, describe, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({
  user: vi.fn(), token: vi.fn(), log: vi.fn(), compare: vi.fn(), limited: vi.fn(), find: vi.fn(), tx: vi.fn(), raw: vi.fn(), update: vi.fn(),
}));
vi.mock("@/lib/db", () => ({ db: {
  user: { findUnique: mocks.user, updateMany: mocks.update }, apiToken: { findFirst: mocks.token },
  loginAttempt: { create: mocks.log }, feed: { aggregate: async () => ({ _max: { lastFetchedAt: null } }) }, article: { findMany: mocks.find },
  $executeRaw: mocks.raw, $transaction: mocks.tx,
} }));
vi.mock("bcryptjs", () => ({ default: { compare: mocks.compare } }));
vi.mock("@/lib/markdown-render", () => ({ renderMarkdownToHtml: vi.fn() }));
vi.mock("@/lib/rate-limit", async importOriginal => ({
  ...await importOriginal<typeof import("@/lib/rate-limit")>(), peekRateLimit: mocks.limited,
}));
import { authenticateGReaderPassword, authenticateGReaderRequest, createGReaderToken } from "../../lib/greader";
import { POST as fever } from "../../app/api/fever/route";
const user = { id: "u1", email: "user@test.com", password: "hash", isActive: true, twoFactorEnabled: false };
beforeEach(() => {
  vi.resetAllMocks();
  mocks.user.mockResolvedValue(user);
  mocks.update.mockResolvedValue({ count: 1 });
  mocks.compare.mockResolvedValue(true);
  mocks.limited.mockReturnValue({ success: true });
  mocks.find.mockResolvedValue([]);
  mocks.tx.mockResolvedValue([1]);
});
describe("GReader password authentication", () => {
  const request = new Request("https://example.test");
  it("throttles before bcrypt without an audit row per rate-limited request (N12)", async () => {
    mocks.limited.mockReturnValue({ success: false });
    expect(await authenticateGReaderPassword(request, user.email, "pw")).toBeNull();
    expect(mocks.compare).not.toHaveBeenCalled();
    expect(mocks.user).not.toHaveBeenCalled();
    expect(mocks.log).not.toHaveBeenCalled();
  });
  it.each([{ isActive: false }, { twoFactorEnabled: true }])("rejects disabled or 2FA account %s", async overrides => {
    mocks.user.mockResolvedValue({ ...user, ...overrides });
    expect(await authenticateGReaderPassword(request, user.email, "pw")).toBeNull();
    expect(mocks.compare).not.toHaveBeenCalled();
  });
  it("does not log successful Basic auth and preserves colons in password", async () => {
    const req = new Request("https://example.test", { headers: { authorization: `Basic ${Buffer.from(`${user.email}:p:w`).toString("base64")}` } });
    expect(await authenticateGReaderRequest(req)).toEqual(user);
    expect(mocks.compare).toHaveBeenCalledWith("p:w", "hash");
    expect(mocks.log).not.toHaveBeenCalled();
  });
  it("rejects suspended users with an existing HMAC token", async () => {
    vi.stubEnv("AUTH_SECRET", "test-key");
    mocks.user.mockResolvedValue({ ...user, isActive: false });
    const req = new Request("https://example.test", { headers: { authorization: `GoogleLogin auth=${createGReaderToken(user.id)}` } });
    expect(await authenticateGReaderRequest(req)).toBeNull();
    vi.unstubAllEnvs();
  });
});
describe("Fever token guards", () => {
  const request = () => new Request("https://example.test/api/fever?api&mark=item&as=read&id=1", {
    method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: "api_key=key",
  });
  it.each([{ expiresAt: new Date(0), user }, { user: { ...user, isActive: false } }])("rejects expired/inactive credentials", async overrides => {
    mocks.token.mockResolvedValue({ scope: "write", ...overrides });
    expect(await (await fever(request())).json()).toMatchObject({ auth: 0 });
    expect(mocks.find).not.toHaveBeenCalled();
  });
  it("rejects marks with read scope", async () => {
    mocks.token.mockResolvedValue({ user, scope: "read" });
    const response = await fever(request());
    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({ api_version: 3, auth: 1, error: "Insufficient token scope" });
    expect(mocks.find).not.toHaveBeenCalled();
  });
  it("allows marks with write scope", async () => {
    mocks.token.mockResolvedValue({ user, scope: "write" });
    mocks.find.mockResolvedValue([{ id: "a1" }]);
    expect((await fever(request())).status).toBe(200);
    expect(mocks.find).toHaveBeenCalledWith(expect.objectContaining({ where: expect.objectContaining({ extId: { in: ["0000000000000000001"] }, userId: user.id }) }));
    expect(mocks.tx).toHaveBeenCalledTimes(1); // one raw UPDATE (no Article.updatedAt bump), see server/articles/user-state.ts
  });
});
