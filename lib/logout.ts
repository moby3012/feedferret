"use client";
import { signOut as authSignOut } from "next-auth/react";
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

export async function signOut(options?: Parameters<typeof authSignOut>[0]) {
  // The offline layer stops FIRST: the session generation of this tab is dropped (in-flight prefetches are
  // aborted, their late answers are refused), before anything is cleared — a response that arrives during
  // the flush below must not be written into the store of the next account.
  revokeOfflineScope();
  const qc = getActiveQueryClient();
  // Queued toggles still go out under this session…
  const batcher = qc ? getStateBatcher(qc) : undefined;
  if (batcher) {
    batcher.flush();
    await Promise.race([batcher.whenIdle(), new Promise((resolve) => setTimeout(resolve, FLUSH_TIMEOUT_MS))]);
  }
  // …then nothing of this account survives in memory or storage for the next one.
  qc?.cancelQueries();
  qc?.clear();
  // Offline article bodies are account data too (IndexedDB, all users on this device). Removing the session
  // record also makes every other tab's writes fail the generation check; then they are told to leave.
  await clearAllOffline();
  // End the server session BEFORE telling other tabs to leave. A tab that
  // reloads on the signal while the cookie is still valid passes the proxy,
  // which rolls the session cookie forward — and that late Set-Cookie can land
  // after the sign-out cleared it, silently signing the device back in.
  const { redirect = true, ...rest } = options ?? {};
  const redirectTo = rest.redirectTo ?? rest.callbackUrl ?? window.location.href;
  const data = await authSignOut({ ...rest, redirectTo, redirect: false });
  announceOfflineSession(null);
  await clearAccountBrowserData();
  if (!redirect) return data;
  const url = data?.url ?? redirectTo;
  window.location.href = url;
  // A URL with only a hash change does not navigate by itself.
  if (url.includes("#")) window.location.reload();
}
