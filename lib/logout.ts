"use client";
import { signOut as authSignOut } from "next-auth/react";
import { getStateBatcher } from "@/features/articles/batcher-registry";
import { setOfflineUser } from "@/features/offline/session";
import { clearAllOffline } from "@/features/offline/store";
import { clearLastSync } from "@/features/sync/last-sync";
import { getActiveQueryClient } from "@/lib/active-query-client";

/** Per-account browser storage (device preferences like the reader layout stay). */
const ACCOUNT_STORAGE_KEYS = ["feedferret:offline-articles:v1"];
/** Longest we hold the sign-out for queued article writes. */
const FLUSH_TIMEOUT_MS = 2000;

export async function signOut(options?: Parameters<typeof authSignOut>[0]) {
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
  // Offline article bodies are account data too (IndexedDB, all users on this device).
  setOfflineUser(null);
  await clearAllOffline();
  try {
    for (const key of ACCOUNT_STORAGE_KEYS) localStorage.removeItem(key);
    clearLastSync(localStorage);
  } catch { /* storage can be unavailable */ }
  try {
    if ("caches" in window) await Promise.all((await caches.keys()).filter(key => key.startsWith("feedferret-runtime-")).map(key => caches.delete(key)));
  } catch { /* Cache storage can be unavailable in private browsing. */ }
  return authSignOut(options);
}
