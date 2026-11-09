import { beforeEach, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({ auth: vi.fn(), user: vi.fn(), users: vi.fn(), settings: vi.fn() }));
vi.mock("@/auth", () => ({ auth: mocks.auth }));
vi.mock("@/lib/db", () => ({ db: { user: { findUnique: mocks.user, findMany: mocks.users }, globalSettings: { findUnique: mocks.settings } } }));
vi.mock("@/lib/mail", () => ({ getConfiguredMailProviders: vi.fn(), sendTestSystemEmail: vi.fn() }));
vi.mock("@/lib/render-sidecar", () => ({ renderWithConfigDetailed: vi.fn() }));
vi.mock("@/lib/rsshub", () => ({ validateRsshubRoute: vi.fn() }));
vi.mock("@/lib/changedetection", () => ({ testChangedetectionConnection: vi.fn() }));
import { getUsers } from "../../app/actions/admin";
beforeEach(() => {
  vi.clearAllMocks();
  mocks.auth.mockResolvedValue({ user: { id: "u1", role: "ADMIN" } });
});
it.each([null, { role: "USER", isActive: true }, { role: "ADMIN", isActive: false }])("denies stale admin session for %s", async current => {
  mocks.user.mockResolvedValue(current);
  await expect(getUsers()).rejects.toThrow("Admin access required");
  expect(mocks.users).not.toHaveBeenCalled();
});
it("allows an active current admin", async () => {
  mocks.user.mockResolvedValue({ role: "ADMIN", isActive: true });
  mocks.settings.mockResolvedValue(null);
  mocks.users.mockResolvedValue([]);
  expect(await getUsers()).toEqual([]);
});
