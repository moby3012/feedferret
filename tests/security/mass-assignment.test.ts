// Server actions receive arbitrary client JSON. Settings/profile/digest/feed
// updates must only write allowlisted fields — never role, email via the wrong
// action, passwordHash, userId, … (privilege escalation / feed re-assignment).
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { PrismaClient } from "@prisma/client";
import { PrismaBetterSqlite3 } from "@prisma/adapter-better-sqlite3";

const state = vi.hoisted(() => ({ db: null as unknown as PrismaClient, session: null as null | { user: { id: string } } }));
vi.mock("@/lib/db", () => ({
  get db() {
    return state.db;
  },
  getDatabaseProvider: () => "sqlite",
}));
vi.mock("@/auth", () => ({ auth: vi.fn(async () => state.session) }));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn(), revalidateTag: vi.fn() }));

import { updateDigestSettings, updateGlobalSettings, updateProfile } from "../../app/actions/settings";
import { updateCategory, updateCategoryOrder, updateFeed } from "../../app/actions/feeds";

const dir = mkdtempSync(join(tmpdir(), "feedferret-mass-assign-"));
const ids = { alice: "", bob: "", feed: "", cat: "", bobCat: "" };

beforeAll(async () => {
  const url = `file:${join(dir, "test.db")}`;
  execFileSync("pnpm", ["exec", "prisma", "db", "push", "--schema", "prisma/schema.generated.prisma"], {
    env: { ...process.env, DATABASE_PROVIDER: "sqlite", DATABASE_URL: url },
    stdio: "pipe",
  });
  state.db = new PrismaClient({ adapter: new PrismaBetterSqlite3({ url }) });
  ids.alice = (await state.db.user.create({ data: { email: "alice@test", name: "Alice" } })).id;
  ids.bob = (await state.db.user.create({ data: { email: "bob@test", name: "Bob" } })).id;
  ids.feed = (await state.db.feed.create({ data: { name: "A", url: "https://a.example/feed", userId: ids.alice } })).id;
  ids.cat = (await state.db.category.create({ data: { name: "Mine", userId: ids.alice } })).id;
  ids.bobCat = (await state.db.category.create({ data: { name: "Bobs", userId: ids.bob } })).id;
  state.session = { user: { id: ids.alice } };
}, 120_000);

afterAll(async () => {
  await state.db?.$disconnect();
  rmSync(dir, { recursive: true, force: true });
});

const evil = { role: "ADMIN", isActive: true, password: "x", apiPasswordHash: "x", email: "pwn@test", apiTokenVersion: 999, twoFactorEnabled: false };

describe("server actions ignore non-allowlisted fields", () => {
  it("updateGlobalSettings cannot escalate role or touch credentials", async () => {
    await updateGlobalSettings({ hideDuplicates: true, ...evil } as never);
    const u = await state.db.user.findUniqueOrThrow({ where: { id: ids.alice } });
    expect(u.role).not.toBe("ADMIN");
    expect(u.email).toBe("alice@test");
    expect(u.password).toBeNull();
    expect(u.apiPasswordHash).toBeNull();
    expect(u.hideDuplicates).toBe(true);
  });

  it("updateProfile only writes name/email", async () => {
    await updateProfile({ name: "Alice B", ...{ role: "ADMIN", password: "x", apiPasswordHash: "x" } } as never);
    const u = await state.db.user.findUniqueOrThrow({ where: { id: ids.alice } });
    expect(u.role).not.toBe("ADMIN");
    expect(u.password).toBeNull();
    expect(u.apiPasswordHash).toBeNull();
    expect(u.name).toBe("Alice B");
  });

  it("updateDigestSettings only writes digest fields", async () => {
    await updateDigestSettings({ digestEnabled: true, ...evil } as never);
    const u = await state.db.user.findUniqueOrThrow({ where: { id: ids.alice } });
    expect(u.role).not.toBe("ADMIN");
    expect(u.digestEnabled).toBe(true);
  });

  it("updateFeed cannot re-assign the feed to another user", async () => {
    await updateFeed(ids.feed, { name: "Renamed", ...{ userId: ids.bob, lastFetched: new Date(0) } } as never);
    const f = await state.db.feed.findUniqueOrThrow({ where: { id: ids.feed } });
    expect(f.userId).toBe(ids.alice);
    expect(f.name).toBe("Renamed");
  });

  it("rejects wrong value types for allowlisted settings", async () => {
    await expect(updateGlobalSettings({ hideDuplicates: "yes" } as never)).rejects.toThrow(/Invalid hideDuplicates/);
  });

  it("updateCategory ignores userId/parentId and clamps limits", async () => {
    await updateCategory(ids.cat, { name: "Renamed", ...{ userId: ids.bob, parentId: ids.bobCat }, updateFrequency: 1 } as never);
    const c = await state.db.category.findUniqueOrThrow({ where: { id: ids.cat } });
    expect(c.userId).toBe(ids.alice);
    expect(c.parentId).toBeNull();
    expect(c.updateFrequency).toBe(5);
  });

  it("updateCategoryOrder refuses another account's category as parent", async () => {
    await expect(updateCategoryOrder([{ id: ids.cat, order: 1, parentId: ids.bobCat }])).rejects.toThrow(/Invalid parent/);
  });

  it("updateFeed clamps fetch limits", async () => {
    await updateFeed(ids.feed, { maxSizeKb: 10_000_000, fetchTimeoutSecs: 99999 } as never);
    const f = await state.db.feed.findUniqueOrThrow({ where: { id: ids.feed } });
    expect(f.maxSizeKb).toBe(20 * 1024);
    expect(f.fetchTimeoutSecs).toBe(120);
  });
});
