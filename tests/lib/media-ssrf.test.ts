import { afterEach, expect, it, vi } from "vitest";
vi.mock("undici", async (original) => ({ ...await original<typeof import("undici")>(), fetch: vi.fn() }));
import { fetch as transport } from "undici";
import { safeFetch } from "@/lib/ssrf";
afterEach(() => vi.clearAllMocks());
it("denies direct private targets and redirects to private targets", async () => {
  await expect(safeFetch("http://127.0.0.1/image", {}, { followRedirects: true })).rejects.toThrow();
  expect(transport).not.toHaveBeenCalled();
  vi.mocked(transport).mockResolvedValue(new Response(null, { status: 302, headers: { location: "http://10.0.0.1/image" } }) as never);
  await expect(safeFetch("https://8.8.8.8/image", {}, { followRedirects: true })).rejects.toThrow("private IP");
  expect(transport).toHaveBeenCalledTimes(1);
});
it("follows public redirects with anonymous headers", async () => {
  vi.mocked(transport).mockResolvedValueOnce(new Response(null, { status: 302, headers: { location: "https://1.1.1.1/image" } }) as never)
    .mockResolvedValueOnce(new Response("image") as never);
  await safeFetch("https://8.8.8.8/image", { headers: { Cookie: "do-not-forward" } }, { followRedirects: true });
  expect(vi.mocked(transport).mock.calls[1][1]?.headers).toEqual({ "User-Agent": "FeedFerret-Media/1.0", Accept: "image/*" });
});
it("checks the streaming redirect guard before contacting the next upstream", async () => {
  vi.mocked(transport).mockResolvedValue(new Response(null, { status: 302, headers: { location: "https://1.1.1.1/image" } }) as never);
  const guard = vi.fn(() => null);
  await expect(safeFetch("https://8.8.8.8/image", {}, { followRedirects: true, redirectGuard: guard })).rejects.toThrow("Redirect refused");
  expect(guard).toHaveBeenCalledWith("https://1.1.1.1/image", "https://8.8.8.8/image");
  expect(transport).toHaveBeenCalledTimes(1);
});
