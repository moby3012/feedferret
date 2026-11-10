// Low-level history access for the nav store (.pm/spec-shell-design.md §1.4).
//
// Every shell entry carries `history.state.ff = { i, k, o? }`:
//   i  number of app-pushed entries beneath this one (i > 0 ⇒ back stays in the app)
//   k  "root" | "scope" | "article" | "overlay"
//   o  overlay id when k = "overlay"
//
// The shell owns the URL while it is mounted; Next's router is NOT told about
// in-shell entries. Next patches pushState/replaceState (in an effect of its
// root) and, for a write without its keys, mirrors the URL into the router with
// a `restore` transition whose commit replaceState()s the current entry AGAIN —
// tens to hundreds of ms later on a slow device, after whatever the user (or a
// test driver) did in between. Our writes therefore carry Next's keys (__NA and
// the tree of the current entry), which makes the patch pass them straight
// through: one op = exactly one synchronous history write. Nothing in the
// shell reads useSearchParams/usePathname; the nav store is the source of truth.
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

/**
 * Next's keys of the current entry. Carried on every write of ours: Next's
 * patch then skips its router sync (no deferred echo write), and a later Back
 * onto the entry is still restorable by Next (no reload) once the shell is gone.
 */
function nextKeys(): Record<string, unknown> {
  const current = (window.history.state ?? {}) as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  for (const key of NEXT_KEYS) if (key in current) out[key] = current[key];
  return out;
}

export function pushEntry(url: string, ff: FfState) {
  window.history.pushState({ ...nextKeys(), ff }, "", url);
}

/** Our own replaceState is in progress (the router-write guard must let it through as is). */
let ownWrite = false;

export function replaceEntry(url: string, ff: FfState) {
  ownWrite = true;
  try {
    window.history.replaceState({ ...nextKeys(), ...customState(ff) }, "", url);
  } finally {
    ownWrite = false;
  }
}

/** True once Next's router has patched the history methods. */
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
 * Guards Next's own writes of the current entry while the shell owns the URL
 * (layered on top of Next's patch).
 *
 * Next's router state does not follow in-shell entries (see top), so whenever
 * it writes history on its own — the commit after a server action or
 * router.refresh(), a late commit of anything it started before the shell
 * took over — it writes ITS (stale) canonical URL and drops custom state. A
 * Next write of the shell's own path therefore keeps the entry's URL and
 * `ff`. Writes for another path (a router navigation away) pass unchanged.
 */
export function keepFfAcrossRouterWrites(): () => void {
  const next = window.history.replaceState;
  const guarded: typeof window.history.replaceState = function (this: History, data, unused, url) {
    // Our own writes carry `__NA` too: never touched.
    const nextData = !ownWrite && data && typeof data === "object" && (data as Record<string, unknown>).__NA ? (data as Record<string, unknown>) : null;
    const target = url == null ? null : new URL(String(url), window.location.href);
    if (nextData && (!target || target.pathname === window.location.pathname)) {
      const ff = readFf();
      if (ff && !nextData.ff) data = { ...nextData, ff };
      url = window.location.href;
    }
    return next.call(this, data, unused, url);
  };
  window.history.replaceState = guarded;
  return () => {
    if (window.history.replaceState === guarded) window.history.replaceState = next;
  };
}

/** Explicit boot signal (`<html data-nav-ready>`): the owned stack is seeded and every later write is synchronous. */
export function setNavReady(ready: boolean) {
  if (ready) document.documentElement.dataset.navReady = "true";
  else delete document.documentElement.dataset.navReady;
}
