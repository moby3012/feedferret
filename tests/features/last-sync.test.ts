import { describe, expect, it } from "vitest";
import { clearLastSync, lastSyncKey, recordSyncResult, syncedWithin } from "../../features/sync/last-sync";

function memoryStorage(initial: Record<string, string> = {}): Storage {
  const map = new Map(Object.entries(initial));
  return {
    get length() {
      return map.size;
    },
    key: (i) => [...map.keys()][i] ?? null,
    getItem: (k) => map.get(k) ?? null,
    setItem: (k, v) => void map.set(k, String(v)),
    removeItem: (k) => void map.delete(k),
    clear: () => map.clear(),
  };
}

const NOW = Date.parse("2026-11-10T10:00:00Z");
const FIVE_MIN = 5 * 60_000;

describe("boot sync stamp (per user, confirmed runs only)", () => {
  it("stamps only a sync the server ran ({ success: true })", () => {
    const s = memoryStorage();
    expect(recordSyncResult(s, "u1", { status: "already_syncing", lastSync: new Date(NOW).toISOString() }, new Date(NOW))).toBe(false);
    expect(recordSyncResult(s, "u1", null, new Date(NOW))).toBe(false);
    expect(recordSyncResult(s, "u1", { success: false }, new Date(NOW))).toBe(false);
    expect(s.length).toBe(0);
    expect(recordSyncResult(s, "u1", { success: true, synced: 3 }, new Date(NOW))).toBe(true);
    expect(s.getItem(lastSyncKey("u1"))).toBe(new Date(NOW).toISOString());
  });

  it("another user's sync on the same browser does not skip this user's boot sync", () => {
    const s = memoryStorage();
    recordSyncResult(s, "u1", { success: true }, new Date(NOW - 60_000));
    expect(syncedWithin(s, "u1", FIVE_MIN, NOW)).toBe(true);
    expect(syncedWithin(s, "u2", FIVE_MIN, NOW)).toBe(false);
  });

  it("the legacy shared key counts for nobody; older than the window or from the future syncs again", () => {
    const s = memoryStorage({ lastSync: new Date(NOW - 1000).toISOString(), [lastSyncKey("u1")]: new Date(NOW - FIVE_MIN - 1).toISOString() });
    expect(syncedWithin(s, "u1", FIVE_MIN, NOW)).toBe(false);
    s.setItem(lastSyncKey("u1"), new Date(NOW + 60_000).toISOString());
    expect(syncedWithin(s, "u1", FIVE_MIN, NOW)).toBe(false);
    expect(syncedWithin(null, "u1", FIVE_MIN, NOW)).toBe(false);
  });

  it("sign-out clears every user's stamp and the legacy key, nothing else", () => {
    const s = memoryStorage({ lastSync: "x", [lastSyncKey("u1")]: "x", [lastSyncKey("u2")]: "x", "ff-reader-layout": "keep" });
    clearLastSync(s);
    expect([...Array(s.length)].map((_, i) => s.key(i))).toEqual(["ff-reader-layout"]);
  });
});
