import { beforeEach, describe, expect, it, vi } from "vitest";
vi.mock("next-intl/server", () => ({ getLocale: async () => "en", getTranslations: async () => () => "Load video" }));
vi.mock("@/lib/db", () => ({ db: { globalSettings: { findUnique: vi.fn() }, user: { findUnique: vi.fn() } } }));
import { clearMediaProxySettingsCache } from "@/lib/media-settings";
import { runHtmlTask } from "@/lib/html-worker/pool";
vi.mock("@/lib/html-worker/pool", () => ({ runHtmlTask: vi.fn() }));
import { db } from "@/lib/db";
import { mediaKey, mediaProxyEnabled, presentMedia, verifyMediaSignature } from "@/lib/media-proxy";
import { canonicalMediaUrl, signedMediaUrl } from "@/lib/media-url";
import { rewriteMediaInProcess } from "@/lib/media-rewrite-core";

beforeEach(() => { clearMediaProxySettingsCache(); vi.clearAllMocks(); process.env.AUTH_SECRET = "synthetic-media-unit-key"; delete process.env.FEEDFERRET_ENCRYPTION_KEY; delete process.env.FEEDFERRET_ENCRYPTION_KEYS_OLD; });
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
  vi.mocked(runHtmlTask).mockResolvedValue(input[0].html);
  expect(await presentMedia(input, "u")).toEqual(input);
  vi.mocked(db.globalSettings.findUnique).mockResolvedValue({ mediaProxyMode: "opt-in" } as never);
  clearMediaProxySettingsCache();
  expect(await mediaProxyEnabled("u")).toBe(true);
  vi.mocked(db.user.findUnique).mockResolvedValue({ mediaProxyImages: false } as never);
  clearMediaProxySettingsCache();
  expect(await mediaProxyEnabled("u")).toBe(false);
  vi.mocked(db.globalSettings.findUnique).mockResolvedValue({ mediaProxyMode: "on" } as never);
  clearMediaProxySettingsCache();
  expect(await mediaProxyEnabled("u")).toBe(true);
});

it("rewrites image inputs and disables media preloading and autoplay", () => {
  const html = rewriteMediaInProcess({
    html: '<input type="image" src="/button.png"><video src="/movie.mp4" autoplay preload="auto"><source src="/movie.webm" autoplay></video><audio autoplay><source src="/podcast.mp3"></audio>',
    base: "https://example.org", keyHex: mediaKey().toString("hex"),
  });
  expect(html).toContain('src="/api/media?');
  expect(html).not.toContain("autoplay");
  expect(html.match(/preload="none"/g)).toHaveLength(4);
  expect(html).toContain('src="/movie.mp4"');
});
it("caches settings, coalesces requests, expires and invalidates writes", async () => {
  vi.mocked(db.globalSettings.findUnique).mockResolvedValue({ mediaProxyMode: "opt-in" } as never);
  vi.mocked(db.user.findUnique).mockResolvedValue({ mediaProxyImages: true } as never);
  await Promise.all(Array.from({ length: 10 }, () => mediaProxyEnabled("cached")));
  expect(db.globalSettings.findUnique).toHaveBeenCalledTimes(1);
  expect(db.user.findUnique).toHaveBeenCalledTimes(1);
  clearMediaProxySettingsCache("cached");
  await mediaProxyEnabled("cached");
  expect(db.globalSettings.findUnique).toHaveBeenCalledTimes(1);
  expect(db.user.findUnique).toHaveBeenCalledTimes(2);
  const now = Date.now();
  const clock = vi.spyOn(Date, "now").mockReturnValue(now + 30_001);
  await mediaProxyEnabled("cached");
  expect(db.globalSettings.findUnique).toHaveBeenCalledTimes(2);
  expect(db.user.findUnique).toHaveBeenCalledTimes(3);
  clock.mockRestore();
});
it("returns safe text and a signed thumbnail if the rewrite worker fails", async () => {
  vi.mocked(db.globalSettings.findUnique).mockResolvedValue({ mediaProxyMode: "on" } as never);
  vi.mocked(runHtmlTask).mockRejectedValue(new Error("worker timeout"));
  const [result] = await presentMedia([{ link: "https://example.org", imageUrl: "https://example.org/cover.png", html: '<p>Hello &lt;world&gt; &amp; &#169;</p><img src="https://example.org/tracker"><input type="image" src="https://example.org/input"><video autoplay src="https://example.org/video"></video>' }], "u");
  expect(result.html).toContain("Hello &lt;world&gt; &amp; ©");
  expect(result.html).not.toContain("&amp;amp;");
  expect(result.html).not.toContain("https://example.org");
  expect(result.html).not.toContain("<img");
  expect(result.html).not.toContain("<video");
  expect(result.imageUrl).toMatch(/^\/api\/media\?/);
});
