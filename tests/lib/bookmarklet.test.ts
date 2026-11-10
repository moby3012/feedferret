import { describe, expect, it } from "vitest";
import { buildBookmarkletHref } from "../../lib/bookmarklet";

describe("buildBookmarkletHref", () => {
  it("is a javascript: URL that targets the share-target deep link of this origin", () => {
    const href = buildBookmarkletHref("https://feeds.example.com/");
    expect(href.startsWith("javascript:(function(){")).toBe(true);
    expect(href).toContain('"https://feeds.example.com/?sharedUrl="');
    expect(href).toContain("encodeURIComponent(location.href)");
  });

  it("evaluates to a navigation to /?sharedUrl=<encoded page url>", () => {
    const href = buildBookmarkletHref("http://localhost:3000");
    const opened: string[] = [];
    const run = new Function("location", "window", "encodeURIComponent", href.replace(/^javascript:/, ""));
    run({ href: "https://a.test/x?y=1&z=2" }, { open: (u: string) => (opened.push(u), {}) }, encodeURIComponent);
    expect(opened).toEqual(["http://localhost:3000/?sharedUrl=https%3A%2F%2Fa.test%2Fx%3Fy%3D1%26z%3D2"]);
  });

  it("falls back to same-tab navigation when popups are blocked", () => {
    const loc = { href: "https://a.test/" };
    const run = new Function("location", "window", "encodeURIComponent", buildBookmarkletHref("http://h").replace(/^javascript:/, ""));
    run(loc, { open: () => null }, encodeURIComponent);
    expect(loc.href).toBe("http://h/?sharedUrl=https%3A%2F%2Fa.test%2F");
  });

  it("matches the manifest share_target query param", async () => {
    const manifest = (await import("../../public/manifest.json")).default as { share_target: { params: { url: string } } };
    expect(buildBookmarkletHref("http://h")).toContain(`?${manifest.share_target.params.url}=`);
  });
});
