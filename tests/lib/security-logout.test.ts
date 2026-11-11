import { afterEach, expect, it, vi } from "vitest";
const order = vi.hoisted(() => [] as string[]);
const authSignOut = vi.hoisted(() => vi.fn(async () => { order.push("server-signout"); return { url: "http://localhost/login" }; }));
vi.mock("next-auth/react", () => ({ signOut: authSignOut }));
vi.mock("@/features/offline/session", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/features/offline/session")>()),
  announceOfflineSession: vi.fn(() => { order.push("announce"); }),
  revokeOfflineScope: vi.fn(() => { order.push("revoke"); }),
}));
vi.mock("@/features/offline/store", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/features/offline/store")>()),
  clearAllOffline: vi.fn(async () => { order.push("wipe-offline"); }),
}));
import { SignOutError, signOut } from "../../lib/logout";
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
  expect(order).toEqual(["server-signout", "revoke", "wipe-offline", "announce"]);
  // …and the offline store is only wiped once the server session is verifiably gone.
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
  expect(order).toEqual(["cancel", "server-signout", "revoke", "clear", "wipe-offline", "announce"]);
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
  expect(fetchMock).toHaveBeenCalledWith("/api/auth/session", expect.objectContaining({ cache: "no-store", signal: expect.any(AbortSignal) }));
  expect(authSignOut).toHaveBeenCalledTimes(3); // the sign-out + one per resurrection
  expect(order.at(-1)).toBe("announce"); // others are told to leave only once the session is really gone
});

it("a failing session check never blocks the sign-out", async () => {
  stubBrowser();
  vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("offline")));
  await expect(signOut({ redirect: false })).resolves.toEqual({ url: "http://localhost/login" });
});

it("verifies the last retry too; a session that survives all of them throws and wipes nothing", async () => {
  order.length = 0;
  const { remove, location } = stubBrowser();
  const fetchMock = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ user: { id: "u1" } }) });
  vi.stubGlobal("fetch", fetchMock);
  const error = await signOut({ callbackUrl: "/login" }).catch((e) => e);
  expect(error).toBeInstanceOf(SignOutError);
  expect(error.code).toBe("failed");
  expect(fetchMock).toHaveBeenCalledTimes(4); // initial check + a check after each of the 3 retries
  expect(authSignOut).toHaveBeenCalledTimes(4);
  // Nothing destroyed, nobody told, the user stays where they are.
  expect(order).toEqual(["server-signout", "server-signout", "server-signout", "server-signout"]);
  expect(remove).not.toHaveBeenCalled();
  expect(location.href).toBe("http://localhost/");
});

it("a third sign-out that finally ends the session goes through", async () => {
  stubBrowser();
  const alive = { ok: true, json: async () => ({ user: { id: "u1" } }) };
  const gone = { ok: true, json: async () => null };
  vi.stubGlobal("fetch", vi.fn().mockResolvedValueOnce(alive).mockResolvedValueOnce(alive).mockResolvedValueOnce(alive).mockResolvedValueOnce(gone));
  await expect(signOut({ redirect: false })).resolves.toEqual({ url: "http://localhost/login" });
  expect(authSignOut).toHaveBeenCalledTimes(4);
});

it("offline: the sign-out request rejects → 'offline' error, offline data and caches untouched", async () => {
  order.length = 0;
  const { remove, location } = stubBrowser();
  authSignOut.mockRejectedValueOnce(new TypeError("Failed to fetch"));
  const error = await signOut({ callbackUrl: "/login" }).catch((e) => e);
  expect(error).toBeInstanceOf(SignOutError);
  expect(error.code).toBe("offline");
  expect(order).toEqual([]); // no revoke / wipe / announce
  expect(remove).not.toHaveBeenCalled();
  expect(location.href).toBe("http://localhost/");
});

it("navigator.onLine === false fails fast without touching anything", async () => {
  order.length = 0;
  stubBrowser();
  vi.stubGlobal("navigator", { onLine: false });
  await expect(signOut()).rejects.toMatchObject({ code: "offline" });
  expect(authSignOut).not.toHaveBeenCalled();
  expect(order).toEqual([]);
});

it("a sign-out request that hangs gives up with 'offline' (it cannot be aborted)", async () => {
  vi.useFakeTimers();
  try {
    stubBrowser();
    authSignOut.mockImplementationOnce(() => new Promise(() => {}));
    const result = signOut().catch((e) => e);
    await vi.advanceTimersByTimeAsync(16_000);
    expect(await result).toMatchObject({ code: "offline" });
  } finally {
    vi.useRealTimers();
  }
});
