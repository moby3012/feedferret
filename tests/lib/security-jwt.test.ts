import { beforeEach, describe, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({ config: null as any, user: vi.fn() }));
vi.mock("next-auth", () => ({ default: (config: any) => { mocks.config = config; return {}; } }));
vi.mock("@auth/prisma-adapter", () => ({ PrismaAdapter: vi.fn() }));
vi.mock("@/lib/db", () => ({ db: { user: { findUnique: mocks.user } } }));
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
