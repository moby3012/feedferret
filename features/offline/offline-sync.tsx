"use client";

import { useEffect, useRef } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { qk } from "@/features/articles/keys";
import { useCountsQuery } from "@/features/bootstrap/queries";
import { isOnline } from "@/features/bootstrap/online";
import { takeServedOffline } from "./offline";
import { setOfflineUser } from "./session";
import { getUsage, purgeOtherUsers, setActiveUser } from "./store";
import { requestPersistentStorage } from "./storage";
import { networkDeps, reconcileReadLater } from "./sync";

/** Re-check while the app stays open and visible. */
const POLL_MS = 10 * 60_000;
/** A burst of Read-later toggles settles before we look at the server. */
const SETTLE_MS = 3000;
/** Pause before the next batch of Read-later bodies. */
const CONTINUE_MS = 5000;
/** First look waits for the list/counts to render. */
const BOOT_DELAY_MS = 4000;

/**
 * Mounted by the reader page (renders nothing). Owns the offline store of the
 * signed-in user: scopes it to this account (other accounts' rows are purged),
 * prefetches the Read-later bodies while online and idle, and asks the browser
 * for persistent storage once there is something worth keeping.
 */
export function OfflineSync({ userId }: { userId: string }) {
  const qc = useQueryClient();
  // Idempotent and needed before any child effect fires a query that falls back to the store.
  setOfflineUser(userId);
  const laterCount = useCountsQuery(false).data?.later;

  const running = useRef(false);
  const rerun = useRef(false);
  const alive = useRef(true);
  const lastRun = useRef(0);
  const continueTimer = useRef<ReturnType<typeof setTimeout>>(undefined);

  const run = useRef(async () => {});
  run.current = async () => {
    if (running.current) {
      rerun.current = true;
      return;
    }
    if (!isOnline() || document.visibilityState === "hidden") return;
    running.current = true;
    lastRun.current = Date.now();
    try {
      const result = await reconcileReadLater(userId, networkDeps(() => !alive.current || !isOnline()));
      const usage = await getUsage(userId);
      if (!result.failed && usage.count > 0) requestPersistentStorage();
      // More bodies waiting than one run fetches: continue calmly instead of waiting for the next trigger.
      if (result.saved > 0 && result.missing > 0 && alive.current) continueTimer.current = setTimeout(() => void run.current(), CONTINUE_MS);
    } catch {
      /* best effort */
    } finally {
      running.current = false;
      if (rerun.current && alive.current) {
        rerun.current = false;
        void run.current();
      }
    }
  };

  // Account scope + boot reconcile + periodic/visibility/online triggers.
  useEffect(() => {
    alive.current = true;
    void purgeOtherUsers(userId).then(() => setActiveUser(userId));
    const boot = setTimeout(() => void run.current(), BOOT_DELAY_MS);
    const poll = setInterval(() => void run.current(), POLL_MS);
    const onVisible = () => {
      if (document.visibilityState === "visible" && Date.now() - lastRun.current > 60_000) void run.current();
    };
    const onOnline = () => {
      // Whatever was answered from the store is stale now.
      const served = takeServedOffline();
      for (const key of served.lists) void qc.invalidateQueries({ queryKey: qk.list(key) });
      for (const id of served.details) void qc.invalidateQueries({ queryKey: qk.article(id) });
      void run.current();
    };
    const onInstalled = () => requestPersistentStorage();
    document.addEventListener("visibilitychange", onVisible);
    window.addEventListener("online", onOnline);
    window.addEventListener("appinstalled", onInstalled);
    if (window.matchMedia?.("(display-mode: standalone)").matches) requestPersistentStorage();
    return () => {
      alive.current = false;
      clearTimeout(boot);
      clearTimeout(continueTimer.current);
      clearInterval(poll);
      document.removeEventListener("visibilitychange", onVisible);
      window.removeEventListener("online", onOnline);
      window.removeEventListener("appinstalled", onInstalled);
    };
  }, [userId, qc]);

  // The Read-later count changed (toggle here or on another device): settle, then mirror.
  const firstCount = useRef(true);
  useEffect(() => {
    if (laterCount === undefined) return;
    if (firstCount.current) {
      firstCount.current = false;
      return;
    }
    const timer = setTimeout(() => void run.current(), SETTLE_MS);
    return () => clearTimeout(timer);
  }, [laterCount]);

  return null;
}
