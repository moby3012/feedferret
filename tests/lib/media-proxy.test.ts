import { beforeEach, describe, expect, it, vi } from "vitest";
vi.mock("@/lib/db", () => ({ db: { globalSettings: { findUnique: vi.fn() }, user: { findUnique: vi.fn() } } }));
import { db } from "@/lib/db";
import { mediaKey, mediaProxyEnabled, presentMedia, verifyMediaSignature } from "@/lib/media-proxy";
import { canonicalMediaUrl, signedMediaUrl } from "@/lib/media-url";
import { rewriteMediaInProcess } from "@/lib/media-rewrite-core";

beforeEach(() => { process.env.AUTH_SECRET = "synthetic-media-unit-key"; delete process.env.FEEDFERRET_ENCRYPTION_KEY; delete process.env.FEEDFERRET_ENCRYPTION_KEYS_OLD; });
describe("media signatures", () => {
  it("canonicalizes and authenticates without accepting legacy raw-secret MACs", async () => {
    const signed = new URL(signedMediaUrl("HTTPS://Example.org:443/a#part", mediaKey()), "https://reader.example");
    expect(signed.searchParams.get("u")).toBe("https://example.org/a");
    expect(verifyMediaSignature(signed.searchParams.get("u")!, signed.searchParams.get("s")!)).toBe(true);
    expect(verifyMediaSignature("https://example.org/b", signed.searchParams.get("s")!)).toBe(false);
    expect(verifyMediaSignature("https://example.org/a", "x")).toBe(false);
    const { createHmac } = await import("node:crypto");
    expect(verifyMediaSignature("https://example.org/a", createHmac("sha256", process.env.AUTH_SECRET!).update("https://example.org/a").digest("hex"))).toBe(false);
    for (const url of ["file:///etc/passwd", "https://user:pass@example.org", "javascript:alert(1)"]) expect(canonicalMediaUrl(url)).toBeNull();
  });
});
it("verifies configured old derived keys after rotation", () => {
  const url = new URL(signedMediaUrl("https://example.org/a", mediaKey()), "https://reader.example");
  process.env.FEEDFERRET_ENCRYPTION_KEY = "synthetic-new-master";
  expect(verifyMediaSignature(url.searchParams.get("u")!, url.searchParams.get("s")!)).toBe(false);
  process.env.FEEDFERRET_ENCRYPTION_KEYS_OLD = process.env.AUTH_SECRET;
  expect(verifyMediaSignature(url.searchParams.get("u")!, url.searchParams.get("s")!)).toBe(true);
});
it("rewrites img, responsive picture and poster, preserving links and data images", () => {
  const html = rewriteMediaInProcess({
    html: '<a href="https://example.org"><picture><source srcset="/a.png 1x, /b.png 2x"><img src="/c.png" srcset="/d.png 640w"></picture></a><video poster="/e.png"></video>',
    base: "http://example.org/article", keyHex: mediaKey().toString("hex"),
  });
  expect(html.match(/\/api\/media\?u=/g)).toHaveLength(5);
  expect(html).toContain('href="https://example.org"');
  expect(html).toContain(" 2x");
  expect(html).toContain(" 640w");
  expect(html).toContain('referrerpolicy="no-referrer"');
});
it("uses off / opt-in / on without changing disabled content", async () => {
  vi.mocked(db.globalSettings.findUnique).mockResolvedValue({ mediaProxyMode: "off" } as never);
  vi.mocked(db.user.findUnique).mockResolvedValue({ mediaProxyImages: true } as never);
  const input = [{ imageUrl: "http://example.org/a.png", link: "https://example.org", html: '<img src="http://example.org/a.png">' }];
  expect(await presentMedia(input, "u")).toBe(input);
  vi.mocked(db.globalSettings.findUnique).mockResolvedValue({ mediaProxyMode: "opt-in" } as never);
  expect(await mediaProxyEnabled("u")).toBe(true);
  vi.mocked(db.user.findUnique).mockResolvedValue({ mediaProxyImages: false } as never);
  expect(await mediaProxyEnabled("u")).toBe(false);
  vi.mocked(db.globalSettings.findUnique).mockResolvedValue({ mediaProxyMode: "on" } as never);
  expect(await mediaProxyEnabled("u")).toBe(true);
});
