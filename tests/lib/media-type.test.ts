import { expect, it } from "vitest";
import { matchesMediaMagic, mediaType } from "@/lib/media-type";
it.each([
  ["png", "89504e470d0a1a0a"], ["jpeg", "ffd8ff"], ["gif", "474946383961"],
  ["webp", "524946460000000057454250"], ["avif", "00000018667479706176696600000000"],
  ["bmp", "424d"], ["x-icon", "00000100"], ["vnd.microsoft.icon", "00000100"],
])("accepts matching %s magic and rejects HTML", (subtype, magic) => {
  expect(matchesMediaMagic("image/" + subtype, Buffer.from(magic, "hex"))).toBe(true);
  expect(matchesMediaMagic("image/" + subtype, Buffer.from("<html>phishing</html>"))).toBe(false);
});
it("rejects unsupported types and ambiguous parameters", () => {
  for (const value of ["image/svg+xml", "image/png,text/html", "image/jpeg; charset=utf-8, text/html", "image/png; charset=utf-8; charset=ascii", "image/png; name=x", "image/jxl"]) expect(mediaType(value)).toBeNull();
});
