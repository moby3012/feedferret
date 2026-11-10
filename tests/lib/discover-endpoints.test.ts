import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  discoverFeeds: vi.fn(),
  user: { id: "u1", email: null, name: null, role: "USER", tokenScope: "read" } as { tokenScope: string } & Record<string, unknown>,
}));

vi.mock("@/auth", () => ({ auth: vi.fn() }));
vi.mock("@/lib/db", () => ({ getDatabaseProvider: () => "sqlite", db: {} }));
vi.mock("@/lib/feed-discovery", () => ({ discoverFeeds: mocks.discoverFeeds }));
vi.mock("@/lib/api-auth", async (original) => ({
  ...(await original<typeof import("@/lib/api-auth")>()),
  requireApiUser: async () => mocks.user,
}));

import { POST as mcp } from "../../app/api/mcp/route";
import { GET as rest } from "../../app/api/v1/[...path]/route";

const candidates = [{ url: "https://github.com/o/r/releases.atom", title: "GitHub · o/r", type: "atom", kind: "releases", platform: "github", confidence: 0.95, source: "resolver" }];

function mcpCall(args: unknown) {
  return mcp(new Request("https://x.test/api/mcp", { method: "POST", body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "feedferret.discover_feeds", arguments: args } }) }));
}
const restCall = (qs: string) => rest(new Request(`https://x.test/api/v1/discover${qs}`), { params: Promise.resolve({ path: ["discover"] }) });

beforeEach(() => {
  mocks.discoverFeeds.mockReset().mockResolvedValue({ mode: "url", feeds: candidates });
  mocks.user.tokenScope = "read";
});

describe("MCP feedferret.discover_feeds", () => {
  it("is advertised and callable with a read-scope token", async () => {
    const list = await (await mcp(new Request("https://x.test/api/mcp", { method: "POST", body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }) }))).json();
    expect(list.result.tools.map((t: { name: string }) => t.name)).toContain("feedferret.discover_feeds");

    const body = await (await mcpCall({ query: "https://github.com/o/r", locale: "de" })).json();
    expect(body.result.isError).toBeUndefined();
    expect(JSON.parse(body.result.content[0].text)).toEqual({ mode: "url", feeds: candidates });
    expect(mocks.discoverFeeds).toHaveBeenCalledWith("https://github.com/o/r", { locale: "de" });
  });

  it("requires a query", async () => {
    const body = await (await mcpCall({ query: "  " })).json();
    expect(body.result.isError).toBe(true);
    expect(body.result.content[0].text).toBe("query is required");
    expect(mocks.discoverFeeds).not.toHaveBeenCalled();
  });
});

describe("REST GET /api/v1/discover", () => {
  it("resolves q through feed-discovery (topic and URL alike)", async () => {
    const res = await restCall("?q=https%3A%2F%2Fgithub.com%2Fo%2Fr&locale=de");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ mode: "url", feeds: candidates });
    expect(mocks.discoverFeeds).toHaveBeenCalledWith("https://github.com/o/r", { locale: "de" });

    mocks.discoverFeeds.mockResolvedValue({ mode: "topic", feeds: [] });
    expect((await (await restCall("?q=rust%20news")).json()).mode).toBe("topic");
  });

  it("accepts the legacy url= parameter, rejects empty and oversized input", async () => {
    expect((await restCall("?url=https%3A%2F%2Fa.test")).status).toBe(200);
    expect((await restCall("")).status).toBe(400);
    expect((await restCall(`?q=${"a".repeat(2001)}`)).status).toBe(400);
  });
});
