import { afterEach, expect, it, vi } from "vitest";
const authSignOut = vi.hoisted(() => vi.fn().mockResolvedValue("signed out"));
vi.mock("next-auth/react", () => ({ signOut: authSignOut }));
import { signOut } from "../../lib/logout";
afterEach(() => vi.unstubAllGlobals());
it("deletes runtime caches while preserving precache and unrelated caches", async () => {
  const remove = vi.fn().mockResolvedValue(true);
  const cache = { keys: vi.fn().mockResolvedValue(["feedferret-pwa-v3", "feedferret-runtime-v1", "feedferret-runtime-v2", "other-app"]), delete: remove };
  vi.stubGlobal("window", { caches: cache });
  vi.stubGlobal("caches", cache);
  await signOut({ callbackUrl: "/login" });
  expect(remove.mock.calls).toEqual([["feedferret-runtime-v1"], ["feedferret-runtime-v2"]]);
  expect(authSignOut).toHaveBeenCalledWith({ callbackUrl: "/login" });
});
