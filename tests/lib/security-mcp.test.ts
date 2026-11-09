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
  it("rejects every advertised tool outside the read allowlist", async () => {
    const read = new Set(["search_articles", "get_article", "list_feeds", "get_feed", "list_categories", "list_labels", "list_saved_searches", "list_keyword_alerts", "list_auto_read_rules", "list_notifications", "list_connectors", "get_stats", "suggest_page_feed"]);
    const response = await POST(new Request("https://example.test/api/mcp", { method: "POST", body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }) }));
    const { result: { tools } } = await response.json();
    expect(tools.length).toBeGreaterThan(0);
    for (const tool of tools) {
      const name = tool.name.replace(/^feedferret\./, "");
      if (read.has(name)) continue;
      const body = await (await POST(request(name))).json();
      expect(body.result.isError, name).toBe(true);
      expect(body.result.content[0].text, name).toBe("Insufficient token scope");
    }
  });
  it("allows list feeds", async () => {
    const body = await (await POST(request("list_feeds"))).json();
    expect(body.result.isError).toBeUndefined();
    expect(mocks.feeds).toHaveBeenCalled();
  });
});
