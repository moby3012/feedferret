import { describe, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({ feeds: vi.fn().mockResolvedValue([]) }));
vi.mock("@/auth", () => ({ auth: vi.fn() }));
vi.mock("@/lib/db", () => ({ getDatabaseProvider: () => "sqlite", db: { feed: { findMany: mocks.feeds } } }));
vi.mock("@/lib/api-auth", async original => ({
  ...await original<typeof import("@/lib/api-auth")>(),
  requireApiUser: async () => ({ id: "u1", email: null, name: null, role: "USER", tokenScope: "read" }),
}));
import { POST } from "../../app/api/mcp/route";
function request(name: string) {
  return new Request("https://example.test/api/mcp", { method: "POST", body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: `feedferret.${name}`, arguments: {} } }) });
}
describe("MCP read token", () => {
  it.each(["add_feed", "delete_feed", "create_auto_read_rule", "mark_all_read", "fetch_full_text", "sync_feeds"])("rejects write tool %s", async name => {
    const body = await (await POST(request(name))).json();
    expect(body.result.isError).toBe(true);
    expect(body.result.content[0].text).toBe("Insufficient token scope");
  });
  it("allows list feeds", async () => {
    const body = await (await POST(request("list_feeds"))).json();
    expect(body.result.isError).toBeUndefined();
    expect(mocks.feeds).toHaveBeenCalled();
  });
});
