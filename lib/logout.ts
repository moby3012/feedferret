"use client";
import { signOut as authSignOut } from "next-auth/react";
import { serverSessionAlive } from "@/features/bootstrap/auth-session";
import { getStateBatcher } from "@/features/articles/batcher-registry";
import { announceOfflineSession, revokeOfflineScope } from "@/features/offline/session";
import { clearAllOffline } from "@/features/offline/store";
import { clearReaderPositions } from "@/features/reader/reader-position";
import { clearLastSync } from "@/features/sync/last-sync";
import { getActiveQueryClient } from "@/lib/active-query-client";

/** Per-account browser storage (device preferences like the reader layout stay). */
// `ff:recent-q`: the last searches — the next person on a shared device must not see them (N16).
const ACCOUNT_STORAGE_KEYS = ["feedferret:offline-articles:v1", "ff:recent-q"];
/** Longest we hold the sign-out for queued article writes. */
const FLUSH_TIMEOUT_MS = 2000;

/** localStorage keys and runtime caches that belong to the signed-in account. The offline IndexedDB store is handled by the session logic. */
export async function clearAccountBrowserData() {
  clearReaderPositions();
  try {
    for (const key of ACCOUNT_STORAGE_KEYS) localStorage.removeItem(key);
    clearLastSync(localStorage);
  } catch { /* storage can be unavailable */ }
  try {
    // Tab-scoped navigation / scroll state (ff:scroll, reader nav sessions) is account data too.
    sessionStorage.clear();
  } catch { /* storage can be unavailable */ }
  try {
    if ("caches" in window) await Promise.all((await caches.keys()).filter(key => key.startsWith("feedferret-runtime-")).map(key => caches.delete(key)));
  } catch { /* Cache storage can be unavailable in private browsing. */ }
}

/** How often a resurrected session is signed out again (each followed by a check). */
const SIGN_OUT_RETRIES = 3;
/** The sign-out request cannot be aborted (next-auth/react takes no signal): stop waiting for it after this long. */
const SIGN_OUT_TIMEOUT_MS = 15_000;

/**
 * Why a sign-out did not happen. In both cases NOTHING was wiped or revoked and the user is still where they
 * were, so the caller only has to tell them: `offline` = the server could not be reached (sign-out needs a
 * connection), `failed` = the server still sees a session after the retries.
 */
export class SignOutError extends Error {
  constructor(readonly code: "offline" | "failed") {
    super(code === "offline" ? "Signing out needs a connection" : "Signing out failed");
    this.name = "SignOutError";
  }
}

type AuthSignOutOptions = Omit<NonNullable<Parameters<typeof authSignOut>[0]>, "redirect">;

/** The server-side sign-out. A rejection (offline: the service worker does not serve /api/*) or a hang means "needs a connection". */
async function endServerSession(options: AuthSignOutOptions) {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      authSignOut({ ...options, redirect: false }),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error("sign-out timed out")), SIGN_OUT_TIMEOUT_MS);
      }),
    ]);
  } catch {
    throw new SignOutError("offline");
  } finally {
    clearTimeout(timer);
  }
}

/**
 * The session cookie is a rolling JWT: ANY authenticated request that was already in flight when the
 * sign-out cleared the cookie (a page/server-action request, a session poll of another tab) answers with a
 * fresh `Set-Cookie` and brings the session back. Check once the dust has settled and sign out again while
 * the server still sees a user; the last retry is verified too. Returns whether the session is gone. A check
 * that cannot be answered (network, timeout) counts as gone — the sign-out request itself was accepted.
 */
async function sessionEnded(options: AuthSignOutOptions): Promise<boolean> {
  for (let retry = 0; ; retry++) {
    try {
      if (!(await serverSessionAlive())) return true;
    } catch {
      return true;
    }
    if (retry >= SIGN_OUT_RETRIES) return false;
    await endServerSession(options);
  }
}

/**
 * Order matters: (1) queued writes go out, (2) the SERVER session ends and is verified, (3) only then the
 * account's offline store, caches and memory are wiped, (4) other tabs are told, (5) redirect. Until (2) has
 * succeeded nothing is destroyed: a sign-out that cannot reach the server (offline) or cannot end the session
 * throws a {@link SignOutError} and leaves the user — and their offline articles — exactly where they were.
 */
export async function signOut(options?: Parameters<typeof authSignOut>[0]) {
  if (typeof navigator !== "undefined" && navigator.onLine === false) throw new SignOutError("offline");
  const qc = getActiveQueryClient();
  // Queued toggles still go out under this session…
  const batcher = qc ? getStateBatcher(qc) : undefined;
  if (batcher) {
    batcher.flush();
    await Promise.race([batcher.whenIdle(), new Promise((resolve) => setTimeout(resolve, FLUSH_TIMEOUT_MS))]);
  }
  // …then in-flight reads are cancelled. The cache itself is NOT cleared yet: clearing it makes every mounted
  // observer (counts, briefing, server-action reads) refetch at once, and those authenticated requests race the
  // sign-out. Their responses roll the session cookie forward (proxy / /api/auth/session) and a late one lands
  // AFTER the sign-out cleared it, silently signing the device back in.
  qc?.cancelQueries();
  const { redirect = true, ...rest } = options ?? {};
  const redirectTo = rest.redirectTo ?? rest.callbackUrl ?? window.location.href;
  const data = await endServerSession({ ...rest, redirectTo });
  if (!(await sessionEnded(rest))) throw new SignOutError("failed");
  // The session is gone: nothing of this account survives in memory or storage for the next one. The offline
  // layer stops first (in-flight prefetches are aborted, their late answers refused), then its store goes.
  revokeOfflineScope();
  // Mounted observers refetch after the clear and answer 401 now; they cannot roll a cookie.
  qc?.clear();
  // Offline article bodies are account data too (IndexedDB, all users on this device). Removing the session
  // record also makes every other tab's writes fail the generation check; then they are told to leave.
  await clearAllOffline();
  // Other tabs are told to leave only now (server session ended first): a tab reloading on the signal while the
  // cookie is still valid would pass the proxy, which rolls the cookie forward and signs the device back in.
  announceOfflineSession(null);
  await clearAccountBrowserData();
  if (!redirect) return data;
  const url = data?.url ?? redirectTo;
  window.location.href = url;
  // A URL with only a hash change does not navigate by itself.
  if (url.includes("#")) window.location.reload();
}
