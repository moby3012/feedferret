import { describe, it, expect } from "vitest";
import { isValidTimeZone } from "../../lib/timezone";

describe("isValidTimeZone", () => {
  it("accepts UTC and real IANA zone names", () => {
    expect(isValidTimeZone("UTC")).toBe(true);
    expect(isValidTimeZone("Europe/Berlin")).toBe(true);
    expect(isValidTimeZone("America/New_York")).toBe(true);
    expect(isValidTimeZone("Asia/Tokyo")).toBe(true);
  });

  it("rejects garbage and non-timezone strings", () => {
    expect(isValidTimeZone("")).toBe(false);
    expect(isValidTimeZone("not-a-timezone")).toBe(false);
    expect(isValidTimeZone("Europe/Nowhere")).toBe(false);
    expect(isValidTimeZone("<script>alert(1)</script>")).toBe(false);
  });
});
