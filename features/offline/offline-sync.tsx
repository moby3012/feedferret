"use client";

import { useEffect, useRef } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { qk } from "@/features/articles/keys";
import { useCountsQuery } from "@/features/bootstrap/queries";
import { isOnline } from "@/features/bootstrap/online";
import { clearReaderPositions } from "@/features/reader/reader-position";
import { clearAccountBrowserData } from "@/lib/logout";
import { isFailedReadQuery, onServedOffline, takeServedOffline } from "./offline";
import { createRecoveryProbe } from "./recovery";
import {
  announceOfflineSession,
  getOfflineScope,
  noteSessionVerified,
  onOfflineScopeChange,
  revokeOfflineScope,
  setOfflineGeneration,
  setOfflineUser,
  watchOfflineSession,
} from "./session";
import { requestPersistentStorage } from "./storage";
import { warmShellChunks } from "./warm-chunks";
import { claimSession, clearIfSessionCurrent, getUsage, markVerified, readSession, type OfflineScope } from "./store";
import { networkDeps, reconcileReadLater } from "./sync";
import { checkServerSession, type ServerSession } from "./verify";

/** Re-check while the app stays open and visible. */
const POLL_MS = 10 * 60_000;
/** A burst of Read-later toggles settles before we look at the server. */
const SETTLE_MS = 3000;
/** Pause before the next batch of Read-later bodies. */
const CONTINUE_MS = 5000;
/** First look waits for the list/counts to render. */
const BOOT_DELAY_MS = 4000;
/** After another tab signed out, the cookie may not be gone yet: do not reload into the old session. */
const SIGNED_OUT_RELOAD_DELAY_MS = 1500;

/**
 * Mounted by the reader page (renders nothing). Owns the offline store of the
 * signed-in user: claims it for this account (other accounts' rows are purged and a new session
 * generation is issued), prefetches the Read-later bodies while online and idle, asks the browser
 * for persistent storage once there is something worth keeping, and leaves when the account of
 * this device changes under it (other tab) or the server no longer knows the session.
 */
/**
 * `<html data-offline-sync="busy|idle">`: a reconcile pass (session check,
 * Read-later list, paced bodies) is running / everything it planned is done.
 * Diagnostics, and the e2e signal that the boot pass is out of the way.
 */
function markPass(state: "busy" | "idle") {
  document.documentElement.dataset.offlineSync = state;
}

export function OfflineSync({ userId }: { userId: string }) {
  const qc = useQueryClient();
  // Idempotent and needed before any child effect fires a query that falls back to the store.
  setOfflineUser(userId);
  const laterCount = useCountsQuery(false).data?.later;

  const running = useRef(false);
  const rerun = useRef(false);
  const alive = useRef(true);
  const chunksWarmed = useRef(false);
  const left = useRef(false);
  const lastRun = useRef(0);
  const continueTimer = useRef<ReturnType<typeof setTimeout>>(undefined);
  /** The pass in flight: its abort controller and the scope it was started for. */
  const current = useRef<{ controller: AbortController; scope: OfflineScope } | null>(null);

  /** This tab's account is no longer the device's: stop everything and reload into whatever the cookie says. */
  const leave = useRef((_o: { clearStore: boolean; reloadDelayMs?: number }) => {});
  leave.current = ({ clearStore, reloadDelayMs = 0 }) => {
    if (left.current) return;
    left.current = true;
    alive.current = false;
    const scope = getOfflineScope();
    current.current?.controller.abort();
    clearTimeout(continueTimer.current);
    revokeOfflineScope();
    qc.cancelQueries();
    qc.clear();
    void (async () => {
      // Only a dead session clears the store (and only if it is still this session's); after an account
      // switch the store already belongs to the new account.
      if (clearStore && scope && (await clearIfSessionCurrent(scope))) announceOfflineSession(null);
      await clearAccountBrowserData();
      setTimeout(() => window.location.reload(), reloadDelayMs);
    })();
  };

  /** Asks the server whether the session is still this account's. Returns the verdict after acting on it. */
  const verify = useRef(async (_scope: OfflineScope): Promise<ServerSession> => "unreachable");
  verify.current = async (scope) => {
    const verdict = await checkServerSession(scope.userId);
    if (getOfflineScope()?.gen !== scope.gen) return "unreachable"; // meanwhile revoked / replaced
    if (verdict === "ok") {
      noteSessionVerified();
      void markVerified(scope);
    } else if (verdict === "unauthorized") leave.current({ clearStore: true });
    else if (verdict === "mismatch") leave.current({ clearStore: false });
    return verdict;
  };

  const run = useRef(async () => {});
  run.current = async () => {
    if (running.current) {
      rerun.current = true;
      return;
    }
    if (!isOnline() || document.visibilityState === "hidden") return;
    const scope = getOfflineScope();
    if (!scope || scope.userId !== userId || left.current) return;
    running.current = true;
    lastRun.current = Date.now();
    markPass("busy");
    let continues = false;
    const controller = new AbortController();
    current.current = { controller, scope };
    const stopped = () => controller.signal.aborted || !alive.current || !isOnline() || getOfflineScope()?.gen !== scope.gen;
    try {
      if ((await verify.current(scope)) !== "ok") return;
      // Lazy shell chunks must be in the SW cache before the connection drops (they are not needed to read, only to navigate).
      if (!chunksWarmed.current) {
        chunksWarmed.current = true;
        await warmShellChunks();
      }
      const result = await reconcileReadLater(scope, networkDeps(stopped, controller.signal));
      const usage = await getUsage(userId);
      if (!result.failed && usage.count > 0) requestPersistentStorage();
      // More bodies waiting than one run fetches: continue calmly instead of waiting for the next trigger.
      if (result.saved > 0 && result.missing > 0 && !result.quota && alive.current) {
        continues = true;
        continueTimer.current = setTimeout(() => void run.current(), CONTINUE_MS);
      }
    } catch {
      /* best effort */
    } finally {
      running.current = false;
      if (current.current?.controller === controller) current.current = null;
      if (!continues && !(rerun.current && alive.current)) markPass("idle");
      if (rerun.current && alive.current) {
        rerun.current = false;
        void run.current();
      }
    }
  };

  /** The server answers again: whatever was served from the store is stale now. */
  const recover = useRef(() => {});
  recover.current = () => {
    const served = takeServedOffline();
    for (const key of served.lists) void qc.invalidateQueries({ queryKey: qk.list(key) });
    for (const id of served.details) void qc.invalidateQueries({ queryKey: qk.article(id) });
    // Lists / bodies that failed while offline (nothing stored) sit in their
    // error state with a retry button — retry them for the user now (on screen only).
    void qc.refetchQueries({ predicate: isFailedReadQuery, type: "active" });
    void run.current();
  };

  // Account scope + boot reconcile + periodic/visibility/online triggers.
  useEffect(() => {
    alive.current = true;
    left.current = false;
    let disposed = false;

    void claimSession(userId).then((claim) => {
      if (disposed || !claim) return;
      if (!setOfflineGeneration(userId, claim.gen)) return;
      // A new generation means every other tab of this device is looking at another account's world.
      if (claim.changed) {
        // Same as the store purge in `claimSession`: other accounts' reading positions go too.
        clearReaderPositions(userId);
        announceOfflineSession(claim.gen);
      }
    });

    // Another tab claimed the device for a different account / signed out → this tab is stale.
    const unwatch = watchOfflineSession((gen) => {
      const mine = getOfflineScope();
      if (mine && gen !== mine.gen) leave.current({ clearStore: false, reloadDelayMs: gen === null ? SIGNED_OUT_RELOAD_DELAY_MS : 0 });
    });
    // A frozen / bfcache'd tab may have missed the message: the store itself is the truth.
    const checkGeneration = async () => {
      const mine = getOfflineScope();
      if (!mine) return;
      const session = await readSession();
      if (getOfflineScope()?.gen === mine.gen && (!session || session.gen !== mine.gen)) leave.current({ clearStore: false });
    };
    // Logout / leave: abort the pass in flight right away.
    const unsubscribe = onOfflineScopeChange(() => {
      const now = getOfflineScope();
      if (current.current && now?.gen !== current.current.scope.gen) current.current.controller.abort();
    });

    const probe = createRecoveryProbe({
      probe: async () => {
        if (!isOnline()) return false; // the `online` event handles that case
        const scope = getOfflineScope();
        if (!scope) return true; // nothing to verify against; stop probing
        return (await verify.current(scope)) !== "unreachable";
      },
      onRecovered: () => recover.current(),
    });
    const unserved = onServedOffline(() => probe.start());

    const boot = setTimeout(() => void run.current(), BOOT_DELAY_MS);
    const poll = setInterval(() => void run.current(), POLL_MS);
    const onVisible = () => {
      if (document.visibilityState !== "visible") return;
      void checkGeneration();
      if (Date.now() - lastRun.current > 60_000) void run.current();
    };
    const onOnline = () => {
      probe.stop();
      recover.current();
    };
    const onInstalled = () => requestPersistentStorage();
    document.addEventListener("visibilitychange", onVisible);
    window.addEventListener("online", onOnline);
    window.addEventListener("appinstalled", onInstalled);
    if (window.matchMedia?.("(display-mode: standalone)").matches) requestPersistentStorage();
    return () => {
      disposed = true;
      alive.current = false;
      current.current?.controller.abort();
      probe.stop();
      unserved();
      unwatch();
      unsubscribe();
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
