import { afterEach, expect, it, vi } from "vitest";
const order = vi.hoisted(() => [] as string[]);
const authSignOut = vi.hoisted(() => vi.fn(async () => { order.push("server-signout"); return { url: "http://localhost/login" }; }));
vi.mock("next-auth/react", () => ({ signOut: authSignOut }));
vi.mock("@/features/offline/session", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/features/offline/session")>()),
  announceOfflineSession: vi.fn(() => { order.push("announce"); }),
}));
import { signOut } from "../../lib/logout";
afterEach(() => vi.unstubAllGlobals());

function stubBrowser() {
  const remove = vi.fn().mockResolvedValue(true);
  const cache = { keys: vi.fn().mockResolvedValue(["feedferret-pwa-v3", "feedferret-runtime-v1", "feedferret-runtime-v2", "other-app"]), delete: remove };
  const location = { href: "http://localhost/", reload: vi.fn() };
  vi.stubGlobal("window", { caches: cache, location });
  vi.stubGlobal("caches", cache);
  return { remove, location };
}

it("deletes runtime caches while preserving precache and unrelated caches", async () => {
  const { remove, location } = stubBrowser();
  await signOut({ callbackUrl: "/login" });
  expect(remove.mock.calls).toEqual([["feedferret-runtime-v1"], ["feedferret-runtime-v2"]]);
  expect(authSignOut).toHaveBeenCalledWith({ callbackUrl: "/login", redirectTo: "/login", redirect: false });
  expect(location.href).toBe("http://localhost/login");
});

it("ends the server session before other tabs are told to leave", async () => {
  order.length = 0;
  stubBrowser();
  await signOut({ callbackUrl: "/login" });
  // A tab reloading on the signal while the cookie is still valid would roll the
  // session cookie forward through the proxy and sign the device back in.
  expect(order).toEqual(["server-signout", "announce"]);
});

it("redirect: false returns the sign-out response without navigating", async () => {
  const { location } = stubBrowser();
  expect(await signOut({ redirect: false })).toEqual({ url: "http://localhost/login" });
  expect(location.href).toBe("http://localhost/");
});
