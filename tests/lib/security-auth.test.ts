import { beforeEach, describe, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({
  user: vi.fn(), token: vi.fn(), log: vi.fn(), compare: vi.fn(), limited: vi.fn(), marks: vi.fn(),
}));
vi.mock("@/lib/db", () => ({ db: {
  user: { findUnique: mocks.user }, apiToken: { findFirst: mocks.token },
  loginAttempt: { create: mocks.log }, article: { updateMany: mocks.marks },
} }));
vi.mock("bcryptjs", () => ({ default: { compare: mocks.compare } }));
vi.mock("@/lib/markdown-render", () => ({ renderMarkdownToHtml: vi.fn() }));
vi.mock("@/lib/rate-limit", async importOriginal => ({
  ...await importOriginal<typeof import("@/lib/rate-limit")>(), checkRateLimit: mocks.limited,
}));
import { authenticateGReaderPassword, authenticateGReaderRequest, createGReaderToken } from "../../lib/greader";
import { POST as fever } from "../../app/api/fever/route";
const user = { id: "u1", email: "user@test.com", password: "hash", isActive: true, twoFactorEnabled: false };
beforeEach(() => {
  vi.resetAllMocks();
  mocks.user.mockResolvedValue(user);
  mocks.compare.mockResolvedValue(true);
  mocks.limited.mockReturnValue({ success: true });
});
describe("GReader password authentication", () => {
  const request = new Request("https://example.test");
  it("throttles before bcrypt and records rejection", async () => {
    mocks.limited.mockReturnValue({ success: false });
    expect(await authenticateGReaderPassword(request, user.email, "pw")).toBeNull();
    expect(mocks.compare).not.toHaveBeenCalled();
    expect(mocks.log).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ success: false, failReason: "rate_limit" }) }));
  });
  it.each([{ isActive: false }, { twoFactorEnabled: true }])("rejects disabled or 2FA account %s", async overrides => {
    mocks.user.mockResolvedValue({ ...user, ...overrides });
    expect(await authenticateGReaderPassword(request, user.email, "pw")).toBeNull();
    expect(mocks.compare).not.toHaveBeenCalled();
  });
  it("logs successful Basic auth and preserves colons in password", async () => {
    const req = new Request("https://example.test", { headers: { authorization: `Basic ${Buffer.from(`${user.email}:p:w`).toString("base64")}` } });
    expect(await authenticateGReaderRequest(req)).toEqual(user);
    expect(mocks.compare).toHaveBeenCalledWith("p:w", "hash");
    expect(mocks.log).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ success: true }) }));
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
  const request = () => new Request("https://example.test/api/fever?api&mark=item&as=read&id=a1", {
    method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: "api_key=key",
  });
  it.each([{ expiresAt: new Date(0), user }, { user: { ...user, isActive: false } }])("rejects expired/inactive credentials", async overrides => {
    mocks.token.mockResolvedValue({ scope: "write", ...overrides });
    expect(await (await fever(request())).json()).toMatchObject({ auth: 0 });
    expect(mocks.marks).not.toHaveBeenCalled();
  });
  it("rejects marks with read scope", async () => {
    mocks.token.mockResolvedValue({ user, scope: "read" });
    expect((await fever(request())).status).toBe(403);
    expect(mocks.marks).not.toHaveBeenCalled();
  });
  it("allows marks with write scope", async () => {
    mocks.token.mockResolvedValue({ user, scope: "write" });
    expect((await fever(request())).status).toBe(200);
    expect(mocks.marks).toHaveBeenCalledWith(expect.objectContaining({ where: { id: "a1", userId: user.id } }));
  });
});
