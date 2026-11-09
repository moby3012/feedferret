import { beforeEach, describe, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({ settings: vi.fn(), count: vi.fn(), create: vi.fn(), transaction: vi.fn(), init: vi.fn() }));
vi.mock("@/lib/db", () => ({ db: { $transaction: mocks.transaction } }));
vi.mock("bcryptjs", () => ({ default: { hash: vi.fn().mockResolvedValue("hash") } }));
vi.mock("@/lib/rate-limit", () => ({ checkRateLimit: () => ({ success: true }), getClientIdentifier: () => "ip:test", rateLimitResponse: vi.fn(), RATE_LIMITS: { authSignIn: {} } }));
import { POST } from "../../app/api/register/route";
beforeEach(() => {
  vi.clearAllMocks();
  mocks.settings.mockResolvedValue(null);
  mocks.count.mockResolvedValue(0);
  mocks.create.mockResolvedValue({ id: "u1" });
  mocks.transaction.mockImplementation(async fn => fn({ globalSettings: { findUnique: mocks.settings, create: mocks.init }, user: { count: mocks.count, create: mocks.create } }));
});
const request = () => new Request("https://example.test/api/register", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ name: "Test", email: "test@example.com", password: "StrongPass123!" }) });
describe("registration policy", () => {
  it("allows the first local admin inside a serializable transaction", async () => {
    expect((await POST(request())).status).toBe(201);
    expect(mocks.transaction).toHaveBeenCalledWith(expect.any(Function), { isolationLevel: "Serializable" });
    expect(mocks.create).toHaveBeenCalledWith({ data: expect.objectContaining({ role: "ADMIN" }) });
  });
  it("preserves legacy open registrations without settings", async () => {
    mocks.count.mockResolvedValue(1);
    expect((await POST(request())).status).toBe(201);
    expect(mocks.init).not.toHaveBeenCalled();
  });
  it("closes subsequent registrations with a disabled setting", async () => {
    mocks.count.mockResolvedValue(1);
    mocks.settings.mockResolvedValue({ registrationsEnabled: false });
    expect((await POST(request())).status).toBe(403);
    expect(mocks.create).not.toHaveBeenCalled();
  });
  it("returns a generic 400 for duplicate accounts", async () => {
    mocks.transaction.mockRejectedValue({ code: "P2002" });
    const response = await POST(request());
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ message: "Registration failed" });
  });
  it("preserves an existing enabled setting", async () => {
    mocks.count.mockResolvedValue(1);
    mocks.settings.mockResolvedValue({ registrationsEnabled: true });
    expect((await POST(request())).status).toBe(201);
    expect(mocks.create).toHaveBeenCalledWith({ data: expect.objectContaining({ role: "USER" }) });
  });
  it("returns retryable conflict when concurrent bootstrap loses serialization", async () => {
    mocks.transaction.mockRejectedValue({ code: "P2034" });
    expect((await POST(request())).status).toBe(409);
  });
});
