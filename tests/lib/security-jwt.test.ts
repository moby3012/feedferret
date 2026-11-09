import { beforeEach, describe, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({ config: null as any, user: vi.fn(), settings: vi.fn(), count: vi.fn(), init: vi.fn() }));
vi.mock("next-auth", () => ({ default: (config: any) => { mocks.config = config; return {}; } }));
vi.mock("@auth/prisma-adapter", () => ({ PrismaAdapter: vi.fn() }));
vi.mock("@/lib/db", () => ({ db: { user: { findUnique: mocks.user, count: mocks.count }, globalSettings: { findUnique: mocks.settings, upsert: mocks.init } } }));
vi.mock("@/lib/mail", () => ({ sendSignInEmail: vi.fn() }));
vi.mock("@/lib/totp", () => ({ verifyTotpToken: vi.fn() }));
import "../../auth";
beforeEach(() => vi.clearAllMocks());
describe("JWT identity revocation", () => {
  const token = { sub: "u1", role: "ADMIN", sv: 1, email: "old@test.com", name: "Old", picture: "private", iat: 42 };
  it.each([null, { isActive: false }, { isActive: true, sessionVersion: 2 }])("strips identity for missing/inactive/revoked user %s", async user => {
    mocks.user.mockResolvedValue(user);
    expect(await mocks.config.callbacks.jwt({ token: { ...token } })).toEqual({ iat: 42 });
  });
  it("refreshes the role from the database", async () => {
    mocks.user.mockResolvedValue({ isActive: true, role: "USER", sessionVersion: 1 });
    expect(await mocks.config.callbacks.jwt({ token: { ...token } })).toMatchObject({ sub: "u1", role: "USER" });
  });
});

describe("OAuth/OIDC registration policy", () => {
  it.each(["oauth", "oidc"])("checks bootstrap and legacy policy for %s", async type => {
    const signIn = () => mocks.config.callbacks.signIn({ user: { email: "new@test.com" }, account: { type } });
    mocks.user.mockResolvedValue(null);
    mocks.settings.mockResolvedValue(null);
    mocks.count.mockResolvedValue(0);
    expect(await signIn()).toBe(true);
    expect(mocks.init).toHaveBeenCalledWith(expect.objectContaining({ create: { id: "global", registrationsEnabled: false } }));
    mocks.init.mockClear();
    mocks.count.mockResolvedValue(1);
    expect(await signIn()).toBe(true);
    expect(mocks.init).not.toHaveBeenCalled();
    mocks.settings.mockResolvedValue({ registrationsEnabled: false });
    expect(await signIn()).toBe(false);
    mocks.count.mockResolvedValue(0);
    expect(await signIn()).toBe(true);
    mocks.count.mockResolvedValue(1);
    mocks.settings.mockResolvedValue({ registrationsEnabled: true });
    expect(await signIn()).toBe(true);
    mocks.settings.mockResolvedValue({ registrationsEnabled: false });
    mocks.user.mockResolvedValue({ isActive: true });
    expect(await signIn()).toBe(true);
    mocks.user.mockResolvedValue({ isActive: false });
    expect(await signIn()).toBe(false);
  });
});
