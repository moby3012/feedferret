import { expect, it, vi } from "vitest";
const engine = vi.hoisted(() => ({ fetch: vi.fn() }));
vi.mock("@/lib/db", () => ({ db: {} }));
vi.mock("../../lib/impit-fetch", () => ({ getImpitFetch: () => engine.fetch, getPinnedImpitFetch: async () => engine.fetch }));
import { safeFetch } from "../../lib/ssrf";
it("retains global FormData for impit's instanceof-based body encoder", async () => {
  engine.fetch.mockImplementation(async (_url, init) => {
    expect(init.body).toBeInstanceOf(FormData);
    expect(init.body.get("field")).toBe("value");
    return new Response("ok");
  });
  const body = new FormData(); body.append("field", "value");
  await (await safeFetch("https://8.8.8.8/", { method: "POST", body }, { impersonate: true, allowInternal: true })).text();
  expect(engine.fetch).toHaveBeenCalledTimes(1);
});
