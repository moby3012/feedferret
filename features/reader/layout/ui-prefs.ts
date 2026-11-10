// Per-device UI prefs in the `ff_ui` cookie (server-readable, so first paint
// can use them — never localStorage/matchMedia before mount). Spec §1.6.

export const UI_COOKIE = "ff_ui";
export const LIST_W_MIN = 320;
export const LIST_W_MAX = 480;

export interface UiPrefs {
  /** Article list column width in px on expanded layouts (clamped 320–480). */
  listW?: number;
  sidebarCollapsed?: boolean;
  /** K2 briefing card: 1 = collapsed, 0 = expanded (absent = expanded). */
  bc?: 0 | 1;
}

export function clampListW(px: number): number {
  return Math.round(Math.min(LIST_W_MAX, Math.max(LIST_W_MIN, px)));
}

export function parseUiCookie(raw: string | undefined | null): UiPrefs {
  if (!raw) return {};
  try {
    const value = JSON.parse(decodeURIComponent(raw)) as Record<string, unknown>;
    const out: UiPrefs = {};
    if (typeof value.listW === "number" && Number.isFinite(value.listW)) out.listW = clampListW(value.listW);
    if (typeof value.sidebarCollapsed === "boolean") out.sidebarCollapsed = value.sidebarCollapsed;
    if (value.bc === 0 || value.bc === 1) out.bc = value.bc;
    return out;
  } catch {
    return {};
  }
}

export function serializeUiCookie(prefs: UiPrefs): string {
  return encodeURIComponent(JSON.stringify(prefs));
}

/** Client: merge + write the cookie (one year, lax). */
export function writeUiPrefs(patch: UiPrefs, current: UiPrefs = readUiPrefsFromDocument()): UiPrefs {
  const next = { ...current, ...patch };
  document.cookie = `${UI_COOKIE}=${serializeUiCookie(next)}; path=/; max-age=31536000; samesite=lax`;
  return next;
}

export function readUiPrefsFromDocument(): UiPrefs {
  const match = document.cookie.split("; ").find((c) => c.startsWith(`${UI_COOKIE}=`));
  return parseUiCookie(match?.slice(UI_COOKIE.length + 1));
}
