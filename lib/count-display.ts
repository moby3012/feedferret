// Unread anti-anxiety rules (spec §4.9): unread numbers are muted text,
// capped at "99+", and the user decides where they show at all
// (`User.countDisplay`, "Zähler anzeigen: Alle · Nur Ordner · Aus").

export const COUNT_DISPLAYS = ["all", "categories", "off"] as const;
export type CountDisplay = (typeof COUNT_DISPLAYS)[number];

export function isCountDisplay(value: unknown): value is CountDisplay {
  return typeof value === "string" && (COUNT_DISPLAYS as readonly string[]).includes(value);
}

/** Stored value → mode; null / unknown = "all" (the default). */
export function parseCountDisplay(value: unknown): CountDisplay {
  return isCountDisplay(value) ? value : "all";
}

/**
 * Where a number sits: `feed` = one feed (sources row, a feed list's top
 * bar); `group` = a folder, label, saved search or smart view (and their top
 * bars); `total` = the overall "N ungelesen".
 */
export type CountPlace = "feed" | "group" | "total";

export function showsCount(mode: CountDisplay, place: CountPlace): boolean {
  if (mode === "off") return false;
  if (mode === "categories") return place !== "feed";
  return true;
}

/** Muted unread number: "99+" above 99, nothing at 0. */
export function formatUnreadCount(n: number): string {
  return n > 99 ? "99+" : String(Math.max(0, Math.trunc(n)));
}
