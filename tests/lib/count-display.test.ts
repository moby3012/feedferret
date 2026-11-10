import { describe, expect, it } from "vitest";
import { formatUnreadCount, isCountDisplay, parseCountDisplay, showsCount } from "../../lib/count-display";

// Spec §4.9: muted counts, capped at 99+, and "Zähler anzeigen: Alle · Nur Kategorien · Aus".
describe("count display", () => {
  it("parses the stored setting, defaulting to all", () => {
    expect(parseCountDisplay(null)).toBe("all");
    expect(parseCountDisplay(undefined)).toBe("all");
    expect(parseCountDisplay("bogus")).toBe("all");
    expect(parseCountDisplay("categories")).toBe("categories");
    expect(parseCountDisplay("off")).toBe("off");
    expect(isCountDisplay("all")).toBe(true);
    expect(isCountDisplay("ALL")).toBe(false);
  });

  it("decides per place", () => {
    expect(["feed", "group", "total"].map((p) => showsCount("all", p as never))).toEqual([true, true, true]);
    expect(["feed", "group", "total"].map((p) => showsCount("categories", p as never))).toEqual([false, true, true]);
    expect(["feed", "group", "total"].map((p) => showsCount("off", p as never))).toEqual([false, false, false]);
  });

  it("caps at 99+", () => {
    expect(formatUnreadCount(1)).toBe("1");
    expect(formatUnreadCount(99)).toBe("99");
    expect(formatUnreadCount(100)).toBe("99+");
    expect(formatUnreadCount(12345)).toBe("99+");
    expect(formatUnreadCount(-1)).toBe("0");
  });
});
