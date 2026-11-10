// Low-level history access for the nav store (.pm/spec-shell-design.md §1.4).
//
// Every shell entry carries `history.state.ff = { i, k, o? }`:
//   i  number of app-pushed entries beneath this one (i > 0 ⇒ back stays in the app)
//   k  "root" | "scope" | "article" | "overlay"
//   o  overlay id when k = "overlay"
//
// Next's app router patches pushState/replaceState (in an effect of its root)
// so native history calls keep `useSearchParams` in sync without an RSC
// round-trip. Its keys (__NA, the tree) must never be passed in by us — the
// patch copies them; passing them would make it skip the router sync.
import type { OverlayId } from "./overlays";

export type EntryKind = "root" | "scope" | "article" | "overlay";

export interface FfState {
  i: number;
  k: EntryKind;
  o?: OverlayId;
}

const NEXT_KEYS = new Set(["__NA", "__PRIVATE_NEXTJS_INTERNALS_TREE", "_N"]);

export function readFf(): FfState | null {
  const ff = (window.history.state as { ff?: unknown } | null)?.ff;
  if (!ff || typeof ff !== "object") return null;
  const { i, k, o } = ff as Partial<FfState>;
  if (typeof i !== "number" || !Number.isFinite(i) || i < 0) return null;
  if (k !== "root" && k !== "scope" && k !== "article" && k !== "overlay") return null;
  return { i: Math.floor(i), k, ...(o ? { o } : {}) };
}

/** Our own (non-Next) keys of the current entry, with `ff` replaced. */
function customState(ff: FfState): Record<string, unknown> {
  const current = (window.history.state ?? {}) as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(current)) if (!NEXT_KEYS.has(key) && key !== "ff") out[key] = value;
  out.ff = ff;
  return out;
}

/** Fallback only (router patch not installed): carry Next's keys ourselves so a later Back is not a reload. */
function unpatchedNextKeys(): Record<string, unknown> {
  if (isRouterPatched()) return {};
  const current = (window.history.state ?? {}) as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  for (const key of NEXT_KEYS) if (key in current) out[key] = current[key];
  return out;
}

export function pushEntry(url: string, ff: FfState) {
  window.history.pushState({ ...unpatchedNextKeys(), ff }, "", url);
}

export function replaceEntry(url: string, ff: FfState) {
  window.history.replaceState({ ...unpatchedNextKeys(), ...customState(ff) }, "", url);
}

/** True once Next's router has patched the history methods (writes are then router-synced). */
export function isRouterPatched(): boolean {
  try {
    return !Function.prototype.toString.call(window.history.pushState).includes("[native code]");
  } catch {
    return true;
  }
}

/**
 * Runs `fn` once Next's history patch is installed. Next installs it in an
 * effect of its root component, which runs AFTER the effects of our (child)
 * components in the same commit — an entry written before that has no `__NA`
 * and Next would reload the page when the user goes back to it.
 */
export function whenRouterReady(fn: () => void): () => void {
  let cancelled = false;
  let tries = 0;
  const attempt = () => {
    if (cancelled) return;
    if (isRouterPatched() || tries++ > 40) fn();
    else window.setTimeout(attempt, tries < 5 ? 0 : 25);
  };
  queueMicrotask(attempt);
  return () => {
    cancelled = true;
  };
}

/** iOS / iPadOS (incl. standalone): the OS animates the edge-swipe back itself. */
export function isIOS(): boolean {
  if (typeof navigator === "undefined") return false;
  return /iP(hone|ad|od)/.test(navigator.userAgent) || (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);
}

export type NavAnim = "push" | "pop" | "none";

export function setNavAnim(anim: NavAnim) {
  document.documentElement.dataset.navAnim = anim;
}

/**
 * Next rewrites the current entry's state after some router updates (a
 * server action that revalidates `/`, router.refresh) WITHOUT custom keys —
 * that would drop `ff` and with it the depth. Layered on top of Next's patch:
 * a Next write (has `__NA`, no `ff`) of the same entry keeps the current `ff`.
 */
export function keepFfAcrossRouterWrites(): () => void {
  const next = window.history.replaceState;
  const guarded: typeof window.history.replaceState = function (this: History, data, unused, url) {
    if (data && typeof data === "object" && (data as Record<string, unknown>).__NA && !(data as Record<string, unknown>).ff) {
      const ff = readFf();
      const sameEntry = !url || new URL(String(url), window.location.href).pathname === window.location.pathname;
      if (ff && sameEntry) data = { ...(data as Record<string, unknown>), ff };
    }
    return next.call(this, data, unused, url);
  };
  window.history.replaceState = guarded;
  return () => {
    if (window.history.replaceState === guarded) window.history.replaceState = next;
  };
}
