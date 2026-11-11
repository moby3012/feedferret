import { afterEach, expect, it, vi } from "vitest";
const order = vi.hoisted(() => [] as string[]);
const authSignOut = vi.hoisted(() => vi.fn(async () => { order.push("server-signout"); return { url: "http://localhost/login" }; }));
vi.mock("next-auth/react", () => ({ signOut: authSignOut }));
vi.mock("@/features/offline/session", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/features/offline/session")>()),
  announceOfflineSession: vi.fn(() => { order.push("announce"); }),
}));
import { signOut } from "../../lib/logout";
import { setActiveQueryClient } from "../../lib/active-query-client";
afterEach(() => {
  vi.unstubAllGlobals();
  setActiveQueryClient(null);
  authSignOut.mockClear();
});

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

it("clears the query cache only after the server session ended (a refetch storm would race the sign-out and roll the cookie back)", async () => {
  order.length = 0;
  stubBrowser();
  setActiveQueryClient({
    cancelQueries: vi.fn(() => { order.push("cancel"); }),
    clear: vi.fn(() => { order.push("clear"); }),
  } as never);
  await signOut({ redirect: false });
  expect(order).toEqual(["cancel", "server-signout", "clear", "announce"]);
});

it("signs out again while a request that was in flight resurrected the session", async () => {
  order.length = 0;
  stubBrowser();
  const alive = { ok: true, json: async () => ({ user: { id: "u1" } }) };
  const gone = { ok: true, json: async () => null };
  const fetchMock = vi.fn().mockResolvedValueOnce(alive).mockResolvedValueOnce(alive).mockResolvedValueOnce(gone);
  vi.stubGlobal("fetch", fetchMock);
  await signOut({ redirect: false });
  expect(fetchMock).toHaveBeenCalledTimes(3);
  expect(fetchMock).toHaveBeenCalledWith("/api/auth/session", expect.objectContaining({ cache: "no-store" }));
  expect(authSignOut).toHaveBeenCalledTimes(3); // the sign-out + one per resurrection
  expect(order.at(-1)).toBe("announce"); // others are told to leave only once the session is really gone
});

it("a failing session check never blocks the sign-out", async () => {
  stubBrowser();
  vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("offline")));
  await expect(signOut({ redirect: false })).resolves.toEqual({ url: "http://localhost/login" });
});

it("gives up after a bounded number of attempts", async () => {
  stubBrowser();
  const fetchMock = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ user: { id: "u1" } }) });
  vi.stubGlobal("fetch", fetchMock);
  await signOut({ redirect: false });
  expect(fetchMock).toHaveBeenCalledTimes(3);
});
