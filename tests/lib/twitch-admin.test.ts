import { beforeEach, describe, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({
  auth: vi.fn(), user: vi.fn(), settings: vi.fn(), upsert: vi.fn(), create: vi.fn(), audit: vi.fn(),
  encrypt: vi.fn(), decrypt: vi.fn(), credentials: vi.fn(), request: vi.fn(), warn: vi.fn(), credentialError: vi.fn(), clearCredentialError: vi.fn(),
}));
vi.mock("@/auth", () => ({ auth: mocks.auth }));
vi.mock("@/lib/db", () => ({ db: {
  user: { findUnique: mocks.user },
  globalSettings: { findUnique: mocks.settings, upsert: mocks.upsert, create: mocks.create },
  adminAuditLog: { create: mocks.audit },
} }));
vi.mock("@/lib/crypto", () => ({ encryptIfValue: mocks.encrypt, decryptIfValue: mocks.decrypt }));
vi.mock("@/lib/logger", () => ({ logger: { warn: mocks.warn, error: vi.fn(), info: vi.fn(), debug: vi.fn() } }));
vi.mock("@/lib/mail", () => ({ getConfiguredMailProviders: vi.fn(async () => []), sendTestSystemEmail: vi.fn() }));
vi.mock("@/lib/render-sidecar", () => ({ renderWithConfigDetailed: vi.fn() }));
vi.mock("@/lib/rsshub", () => ({ validateRsshubRoute: vi.fn(async () => ({ ok: true, itemCount: 1 })) }));
vi.mock("@/lib/changedetection", () => ({ testChangedetectionConnection: vi.fn() }));
vi.mock("@/lib/starter-packs.server", () => ({ getStarterPacksFromSettings: vi.fn(async () => []) }));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("@/lib/twitch", () => ({ getTwitchCredentials: mocks.credentials, twitchRequest: mocks.request, getTwitchCredentialError: mocks.credentialError, clearTwitchCredentialError: mocks.clearCredentialError }));
import { ApiSourceDeferredError } from "../../lib/api-source-errors";
import { getGlobalSettings, testRsshubConnection, testTwitchConnection, updateGlobalSettings } from "../../app/actions/admin";

let admin = 0;
beforeEach(() => {
  vi.clearAllMocks();
  // A fresh admin id per test: the per-admin rate-limit bucket starts empty.
  mocks.auth.mockResolvedValue({ user: { id: `admin-${++admin}`, role: "ADMIN" } });
  mocks.user.mockResolvedValue({ role: "ADMIN", isActive: true });
  mocks.settings.mockResolvedValue(null);
  mocks.encrypt.mockImplementation((value: string) => `enc(${value})`);
  mocks.request.mockResolvedValue([]);
  mocks.credentialError.mockReturnValue(null);
});

describe("Twitch admin settings", () => {
  it("encrypts a new secret but never re-encrypts the __encrypted__ sentinel", async () => {
    await updateGlobalSettings({ twitchClientId: " id ", twitchClientSecret: "__encrypted__" });
    expect(mocks.encrypt).not.toHaveBeenCalled();
    const update = mocks.upsert.mock.calls[0][0].update;
    expect(update).toEqual({ twitchClientId: "id" });
    expect(update).not.toHaveProperty("twitchClientSecret");

    await updateGlobalSettings({ twitchClientSecret: "fresh-secret" });
    expect(mocks.encrypt).toHaveBeenCalledWith("fresh-secret");
    expect(mocks.upsert.mock.calls[1][0].update.twitchClientSecret).toBe("enc(fresh-secret)");
  });

  it("getGlobalSettings masks the stored secret", async () => {
    mocks.settings.mockResolvedValue({ id: "global", twitchClientId: "id", twitchClientSecret: "ciphertext", mailProvider: "smtp", starterPacksJson: null });
    const settings = await getGlobalSettings();
    expect(settings.twitchClientSecret).toBe("__encrypted__");
    expect(settings.twitchClientId).toBe("id");
    expect(JSON.stringify(settings)).not.toContain("ciphertext");
  });

  it("test-connection resolves the sentinel to the stored secret, ephemerally, without echoing it", async () => {
    mocks.credentials.mockResolvedValue({ clientId: "stored-id", clientSecret: "stored-secret" });
    const result = await testTwitchConnection({ clientId: "typed-id", clientSecret: "__encrypted__" });
    expect(result).toEqual({ success: true });
    expect(mocks.request).toHaveBeenCalledWith("users", { login: "twitch" }, { clientId: "typed-id", clientSecret: "stored-secret" }, undefined, { ephemeral: true });
    expect(JSON.stringify(result)).not.toContain("stored-secret");
  });

  it("test-connection uses a typed secret as-is and logs only the status code on failure", async () => {
    mocks.request.mockRejectedValue(Object.assign(new Error("SENSITIVE-BODY client_secret=typed-secret"), { status: 400 }));
    const result = await testTwitchConnection({ clientId: "id", clientSecret: "typed-secret" });
    expect(result.success).toBe(false);
    expect(mocks.credentials).not.toHaveBeenCalled();
    expect(mocks.warn).toHaveBeenCalledTimes(1);
    const logged = JSON.stringify(mocks.warn.mock.calls);
    expect(logged).toContain("400");
    expect(logged).not.toContain("typed-secret");
    expect(logged).not.toContain("SENSITIVE");
    expect(JSON.stringify(result)).not.toContain("typed-secret");
  });

  it("getGlobalSettings surfaces the last credential error; saving new credentials clears it", async () => {
    const recorded = { at: "2026-11-12T08:00:00.000Z", status: 401 };
    mocks.credentialError.mockReturnValue(recorded);
    mocks.settings.mockResolvedValue({ id: "global", twitchClientId: "id", twitchClientSecret: "ciphertext", mailProvider: "smtp", starterPacksJson: null });
    expect((await getGlobalSettings()).twitchCredentialError).toEqual(recorded);
    await updateGlobalSettings({ rsshubEnabled: true });
    expect(mocks.clearCredentialError).not.toHaveBeenCalled();
    await updateGlobalSettings({ twitchClientSecret: "new-secret" });
    expect(mocks.clearCredentialError).toHaveBeenCalledTimes(1);
  });

  it("reports a specific rate-limited message with the retry delay", async () => {
    mocks.request.mockRejectedValue(new ApiSourceDeferredError("rate-limited", "Twitch rate limit reached.", 429, 42_100));
    const result = await testTwitchConnection({ clientId: "id", clientSecret: "secret" });
    expect(result).toMatchObject({ success: false, rateLimited: true, retryAfterSecs: 43 });
    expect((result as { error: string }).error).toContain("43");
    expect((result as { error: string }).error).not.toContain("Check credentials");
    // Other deferred reasons keep the generic message.
    mocks.request.mockRejectedValue(new ApiSourceDeferredError("auth", "x", 401));
    expect(await testTwitchConnection({ clientId: "id", clientSecret: "secret" })).not.toHaveProperty("rateLimited");
  });

  it("rejects missing credentials without any outbound request", async () => {
    mocks.credentials.mockResolvedValue(null);
    expect((await testTwitchConnection({ clientId: "id", clientSecret: "__encrypted__" })).success).toBe(false);
    expect((await testTwitchConnection({ clientId: " ", clientSecret: "x" })).success).toBe(false);
    expect(mocks.request).not.toHaveBeenCalled();
  });

  it.each([null, { role: "USER", isActive: true }, { role: "ADMIN", isActive: false }])("rejects non-admin (%j)", async (current) => {
    mocks.user.mockResolvedValue(current);
    await expect(testTwitchConnection({ clientId: "id", clientSecret: "secret" })).rejects.toThrow("Admin access required");
    await expect(updateGlobalSettings({ twitchClientId: "id" })).rejects.toThrow("Admin access required");
    await expect(getGlobalSettings()).rejects.toThrow("Admin access required");
    expect(mocks.request).not.toHaveBeenCalled();
    expect(mocks.upsert).not.toHaveBeenCalled();
  });

  it("rate-limits connection tests per admin (shared by Twitch and RSSHub)", async () => {
    for (let i = 0; i < 10; i++) expect((await testTwitchConnection({ clientId: "id", clientSecret: "secret" })).success).toBe(true);
    const limited = await testTwitchConnection({ clientId: "id", clientSecret: "secret" });
    expect(limited.success).toBe(false);
    expect(mocks.request).toHaveBeenCalledTimes(10);
    expect((await testRsshubConnection({ baseUrl: "https://rsshub.example.com" })).success).toBe(false);
    // Another admin has their own budget.
    mocks.auth.mockResolvedValue({ user: { id: "another-admin", role: "ADMIN" } });
    expect((await testTwitchConnection({ clientId: "id", clientSecret: "secret" })).success).toBe(true);
  });
});
