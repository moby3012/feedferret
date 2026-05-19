import { describe, it, expect } from "vitest";
import { generateMarkReadUrl, verifyMarkReadUrl } from "../../lib/telegram-callback";

describe("telegram-callback", () => {
  it("generates and verifies a valid URL", () => {
    const url = generateMarkReadUrl("article1", "user1", "https://example.com");
    const parsed = new URL(url);
    const id = parsed.searchParams.get("id")!;
    const uid = parsed.searchParams.get("uid")!;
    const exp = parsed.searchParams.get("exp")!;
    const sig = parsed.searchParams.get("sig")!;
    expect(verifyMarkReadUrl(id, uid, exp, sig)).toBe(true);
  });

  it("rejects tampered articleId", () => {
    const url = generateMarkReadUrl("article1", "user1", "https://example.com");
    const parsed = new URL(url);
    const uid = parsed.searchParams.get("uid")!;
    const exp = parsed.searchParams.get("exp")!;
    const sig = parsed.searchParams.get("sig")!;
    expect(verifyMarkReadUrl("tampered", uid, exp, sig)).toBe(false);
  });

  it("rejects expired links", () => {
    const pastExp = String(Math.floor(Date.now() / 1000) - 1);
    const result = verifyMarkReadUrl("a", "u", pastExp, "anysig");
    expect(result).toBe(false);
  });
});
