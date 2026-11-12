import { beforeEach, expect, it, vi } from "vitest";
vi.mock("@/lib/api-auth", () => ({ resolveSessionUser: vi.fn() }));
vi.mock("@/lib/media-proxy", () => ({ mediaProxyEnabled: vi.fn(), verifyMediaSignature: vi.fn() }));
vi.mock("@/lib/ssrf", () => ({ safeFetch: vi.fn() }));
import { GET, MAX_MEDIA_BYTES } from "@/app/api/media/route";
import { resolveSessionUser } from "@/lib/api-auth";
import { mediaProxyEnabled, verifyMediaSignature } from "@/lib/media-proxy";
import { safeFetch } from "@/lib/ssrf";
beforeEach(() => {
  vi.mocked(resolveSessionUser).mockResolvedValue({ id: "media-unit" } as never);
  vi.mocked(mediaProxyEnabled).mockResolvedValue(true);
  vi.mocked(verifyMediaSignature).mockReturnValue(true);
});
const request = () => new Request("https://reader.example/api/media?u=https%3A%2F%2Fexample.org%2Fa&s=test", { headers: { Cookie: "private-cookie", Authorization: "private-token", Referer: "https://private.example" } });
it("rejects invalid signatures and missing sessions before fetching", async () => {
  vi.mocked(verifyMediaSignature).mockReturnValue(false);
  expect((await GET(request())).status).toBe(403);
  vi.mocked(verifyMediaSignature).mockReturnValue(true);
  vi.mocked(mediaProxyEnabled).mockResolvedValue(false);
  expect((await GET(request())).status).toBe(403);
  vi.mocked(resolveSessionUser).mockResolvedValue(null);
  expect((await GET(request())).status).toBe(401);
});
it("streams with privacy headers and only anonymous upstream headers", async () => {
  vi.mocked(safeFetch).mockResolvedValue(new Response("image", { headers: { "content-type": "image/png", etag: '"v1"', "last-modified": "Wed, 01 Jan 2025 00:00:00 GMT", "set-cookie": "private" } }));
  const response = await GET(request());
  expect(await response.text()).toBe("image");
  expect(response.headers.get("content-type")).toBe("image/png");
  expect(response.headers.get("cache-control")).toBe("public, max-age=604800, immutable");
  expect(response.headers.get("content-security-policy")).toBe("default-src 'none'");
  expect(response.headers.get("cross-origin-resource-policy")).toBe("same-origin");
  expect(response.headers.get("x-content-type-options")).toBe("nosniff");
  expect(response.headers.get("etag")).toBe('"v1"');
  expect(response.headers.has("set-cookie")).toBe(false);
  const [, init, options] = vi.mocked(safeFetch).mock.lastCall!;
  expect(init?.headers).toEqual({ "User-Agent": "FeedFerret-Media/1.0", Accept: "image/*" });
  expect(options?.allowInternal).toBe(false);
});
it("refuses HTML, SVG and declared oversized images", async () => {
  for (const type of ["text/html", "image/svg+xml"]) {
    vi.mocked(safeFetch).mockResolvedValue(new Response("bad", { headers: { "content-type": type } }));
    expect((await GET(request())).status).toBe(415);
  }
  vi.mocked(safeFetch).mockResolvedValue(new Response("large", { headers: { "content-type": "image/png", "content-length": String(MAX_MEDIA_BYTES + 1) } }));
  expect((await GET(request())).status).toBe(413);
});
it("aborts an oversized chunked body without forwarding the excess", async () => {
  vi.mocked(safeFetch).mockResolvedValue(new Response(new ReadableStream({
    start(c) { c.enqueue(new Uint8Array(MAX_MEDIA_BYTES)); c.enqueue(new Uint8Array(1)); c.close(); },
  }), { headers: { "content-type": "image/png" } }));
  const response = await GET(request());
  await expect(response.arrayBuffer()).rejects.toThrow("Media size limit");
});
