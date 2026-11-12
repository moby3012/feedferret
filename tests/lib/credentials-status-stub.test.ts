// Deprecated stub (remove next release): answers every request identically and touches nothing.
import { expect, it, vi } from "vitest";

const db = vi.hoisted(() => ({ user: { findUnique: vi.fn() } }));
vi.mock("@/lib/db", () => ({ db }));
import { POST } from "../../app/api/auth/credentials-status/route";

it("answers 200 {requiresTwoFactor:false} and never reads the database", async () => {
  const res = await POST();
  expect(res.status).toBe(200);
  expect(await res.json()).toEqual({ requiresTwoFactor: false });
  expect(db.user.findUnique).not.toHaveBeenCalled();
});
