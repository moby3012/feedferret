// The signed-in user as the offline layer of THIS TAB sees it, plus the cross-tab signal.
//
//  * `userId` comes from the server page (<OfflineSync userId>), `gen` from the claim on the shared
//    IndexedDB session record (store.ts `claimSession`). Writes need both (see `getOfflineScope`);
//    reads of the store need the user only. `null` user = unknown → the offline layer stays inert.
//  * Logout / account switch BUMPS this state first (listeners abort in-flight work), then the store is
//    cleared, then the other tabs are told. The authoritative gate stays the generation check inside the
//    IndexedDB transaction (store.ts) — the messages only make stale tabs stop and reload promptly.
import { isSessionFresh, type OfflineScope } from "./store";

let userId: string | null = null;
let gen: string | null = null;
let verifiedAt = 0;
/** Set by `revokeOfflineScope`: a revoked tab never gets its user back by re-rendering (it reloads instead). */
let revoked = false;
const listeners = new Set<() => void>();
let waiters: Array<(scope: OfflineScope | null) => void> = [];

function changed() {
  for (const listener of [...listeners]) listener();
}

function settleWaiters() {
  const scope = getOfflineScope();
  const pending = waiters;
  if (!scope && userId !== null) return; // still waiting for the claim
  waiters = [];
  for (const resolve of pending) resolve(scope);
}

/** Idempotent; called while rendering, before any child effect can start a query that falls back to the store. */
export function setOfflineUser(next: string | null) {
  if (userId === next || (revoked && next !== null)) return;
  userId = next;
  gen = null;
  verifiedAt = 0;
  settleWaiters();
  changed();
}

/** The claim succeeded: writes may now run as (user, gen). Ignored when the user changed meanwhile. */
export function setOfflineGeneration(forUser: string, next: string, now = Date.now()): boolean {
  if (userId !== forUser) return false;
  gen = next;
  verifiedAt = now;
  settleWaiters();
  changed();
  return true;
}

/** Logout / the session ended: nothing of this tab may use the offline layer any more. */
export function revokeOfflineScope() {
  revoked = true;
  if (userId === null && gen === null) return;
  userId = null;
  gen = null;
  verifiedAt = 0;
  settleWaiters();
  changed();
}

/** Tests only. */
export function resetOfflineSessionForTests() {
  userId = null;
  gen = null;
  verifiedAt = 0;
  revoked = false;
  waiters = [];
  listeners.clear();
}

export function noteSessionVerified(now = Date.now()) {
  if (gen !== null) verifiedAt = now;
}

export function getOfflineUser(): string | null {
  return userId;
}

/** (user, generation) once claimed — what every write is bound to. */
export function getOfflineScope(): OfflineScope | null {
  return userId !== null && gen !== null ? { userId, gen } : null;
}

/** Resolves with the scope as soon as the claim finished (or `null` when it will not happen / the tab was revoked). */
export function whenOfflineScope(timeoutMs = 5000): Promise<OfflineScope | null> {
  const scope = getOfflineScope();
  if (scope || userId === null) return Promise.resolve(scope);
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      waiters = waiters.filter((w) => w !== wrapped);
      resolve(null);
    }, timeoutMs);
    const wrapped = (s: OfflineScope | null) => {
      clearTimeout(timer);
      resolve(s);
    };
    waiters.push(wrapped);
  });
}

/** True once the server has not confirmed the session for longer than the offline policy allows. */
export function isOfflineSessionExpired(now = Date.now()): boolean {
  return userId === null || !isSessionFresh(verifiedAt, now);
}

export function onOfflineScopeChange(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

// ---------------------------------------------------------------- cross-tab signal

const CHANNEL_NAME = "feedferret-offline-session";
/** Fallback for browsers without BroadcastChannel: a `storage` event. Holds a random generation id only. */
const SIGNAL_KEY = "feedferret:offline-session-signal";

/** `gen` = the generation now valid on this device, `null` = signed out. */
export function announceOfflineSession(next: string | null) {
  try {
    const channel = new BroadcastChannel(CHANNEL_NAME);
    channel.postMessage({ gen: next });
    channel.close();
  } catch {
    /* no BroadcastChannel */
  }
  try {
    localStorage.setItem(SIGNAL_KEY, JSON.stringify({ gen: next, at: Date.now(), n: Math.random() }));
  } catch {
    /* storage can be unavailable */
  }
}

/** Calls `onSignal` with the generation another tab announced. Returns the unsubscribe. */
export function watchOfflineSession(onSignal: (gen: string | null) => void): () => void {
  let channel: BroadcastChannel | undefined;
  try {
    channel = new BroadcastChannel(CHANNEL_NAME);
    channel.onmessage = (event: MessageEvent) => {
      const data = event.data as { gen?: string | null } | null;
      if (data && "gen" in data) onSignal(data.gen ?? null);
    };
  } catch {
    channel = undefined;
  }
  const onStorage = (event: StorageEvent) => {
    if (event.key !== SIGNAL_KEY || !event.newValue) return;
    try {
      const data = JSON.parse(event.newValue) as { gen?: string | null };
      onSignal(data.gen ?? null);
    } catch {
      /* ignore garbage */
    }
  };
  window.addEventListener("storage", onStorage);
  return () => {
    channel?.close();
    window.removeEventListener("storage", onStorage);
  };
}
