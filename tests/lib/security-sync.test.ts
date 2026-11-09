import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";
const { sync, userSync, auth } = vi.hoisted(() => ({ sync: vi.fn(), userSync: vi.fn(), auth: vi.fn() }));
vi.mock("@/auth", () => ({ auth }));
vi.mock("@/lib/rss-sync", () => ({ syncAllFeeds: sync, syncUserFeeds: userSync }));
let GET: typeof import("../../app/api/sync/route").GET;
let POST: typeof import("../../app/api/sync/route").POST;
beforeEach(async () => { vi.resetModules(); ({ GET, POST } = await import("../../app/api/sync/route")); });
afterEach(() => { vi.unstubAllEnvs(); vi.clearAllMocks(); });
describe("sync GET", () => {
  it("returns 404 without running sync when missing or incorrect secret", async () => {
    for (const secret of ["", "configured"]) {
      vi.stubEnv("SYNC_SECRET", secret);
      expect((await GET(new Request("https://example.test/api/sync"))).status).toBe(404);
    }
    expect(sync).not.toHaveBeenCalled();
  });
  it("omits feed URLs from the response", async () => {
    vi.stubEnv("SYNC_SECRET", "configured");
    sync.mockResolvedValue([{ feed: "https://private.test/rss?token=secret", success: true, count: 2 }]);
    const response = await GET(new Request("https://example.test/api/sync", { headers: { authorization: "Bearer configured" } }));
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body).toMatchObject({ synced: 1, results: [{ success: true, count: 2 }] });
    expect(JSON.stringify(body)).not.toContain("private.test");
  });
});

it("user POST does not consume the cron GET cooldown", async () => {
  vi.stubEnv("SYNC_SECRET", "configured");
  auth.mockResolvedValue({ user: { id: "u1" } });
  userSync.mockResolvedValue([]);
  sync.mockResolvedValue([]);
  expect((await POST(new Request("https://example.test/api/sync", { method: "POST" }))).status).toBe(200);
  const request = () => new Request("https://example.test/api/sync", { headers: { authorization: "Bearer configured" } });
  expect(await (await GET(request())).json()).toMatchObject({ success: true });
  expect(await (await GET(request())).json()).toMatchObject({ status: "already_syncing" });
  expect(sync).toHaveBeenCalledTimes(1);
});
