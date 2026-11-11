// N9: instance-wide import slots (one import at a time by default, one per user).
import { afterEach, describe, expect, it } from "vitest";
import { acquireImportSlot, ImportBusyError, importBusyResponse, importSlotUsage, maxConcurrentImports, withImportSlot } from "../../lib/import/import-slots";

const reason = async (p: Promise<unknown>) => {
  try {
    await p;
  } catch (error) {
    if (error instanceof ImportBusyError) return error.reason;
    throw error;
  }
  return "acquired";
};

afterEach(() => {
  delete process.env.FEEDFERRET_MAX_CONCURRENT_IMPORTS;
});

describe("import slots", () => {
  it("defaults to one slot and clamps the env override", () => {
    expect(maxConcurrentImports()).toBe(1);
    process.env.FEEDFERRET_MAX_CONCURRENT_IMPORTS = "3";
    expect(maxConcurrentImports()).toBe(3);
    process.env.FEEDFERRET_MAX_CONCURRENT_IMPORTS = "999";
    expect(maxConcurrentImports()).toBe(16);
    process.env.FEEDFERRET_MAX_CONCURRENT_IMPORTS = "0";
    expect(maxConcurrentImports()).toBe(1);
    process.env.FEEDFERRET_MAX_CONCURRENT_IMPORTS = "abc";
    expect(maxConcurrentImports()).toBe(1);
  });

  it("refuses a second import instance-wide (fail fast) and per user", async () => {
    const release = await acquireImportSlot("a");
    expect(await reason(acquireImportSlot("b"))).toBe("instance");
    expect(await reason(acquireImportSlot("a"))).toBe("user");
    release();
    release(); // idempotent
    expect(importSlotUsage()).toEqual({ active: 0, users: [] });
    const again = await acquireImportSlot("b");
    again();
  });

  it("lets a waiter take the slot once it frees up, and times out otherwise", async () => {
    const release = await acquireImportSlot("a");
    const waiting = acquireImportSlot("b", { waitMs: 5_000 });
    setTimeout(release, 20);
    const got = await waiting;
    expect(importSlotUsage().users).toEqual(["b"]);
    expect(await reason(acquireImportSlot("c", { waitMs: 30 }))).toBe("instance");
    got();
  });

  it("allows N parallel imports when configured", async () => {
    process.env.FEEDFERRET_MAX_CONCURRENT_IMPORTS = "2";
    const r1 = await acquireImportSlot("a");
    const r2 = await acquireImportSlot("b");
    expect(await reason(acquireImportSlot("c"))).toBe("instance");
    r1();
    r2();
  });

  it("releases the slot when the work throws", async () => {
    await expect(withImportSlot("a", async () => { throw new Error("boom"); })).rejects.toThrow("boom");
    expect(importSlotUsage().active).toBe(0);
  });

  it("maps busy errors to 429 + Retry-After (instance) and 409 (same user)", async () => {
    const busy = importBusyResponse(new ImportBusyError("instance"));
    expect(busy.status).toBe(429);
    expect(busy.headers.get("Retry-After")).toBe("60");
    expect(importBusyResponse(new ImportBusyError("user")).status).toBe(409);
  });
});
