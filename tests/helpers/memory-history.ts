/**
 * In-memory browser history for nav-store unit tests (node environment).
 *
 * Entry 0 is a page of ANOTHER site the user came from: landing there means
 * the app was left (Back exits). `go()` traverses asynchronously and then
 * fires `popstate`, like a browser.
 */

const ORIGIN = "https://feedferret.test";
const EXTERNAL = "https://elsewhere.test/page";

export interface PopEvent {
  type: string;
  stopImmediatePropagation: () => void;
}

interface Entry {
  url: URL;
  state: unknown;
}

const clone = <T>(value: T): T => (value === undefined ? value : structuredClone(value));

export class MemoryHistory {
  entries: Entry[];
  index: number;
  private listeners = new Set<(e: PopEvent) => void>();

  constructor(initialPath: string) {
    this.entries = [
      { url: new URL(EXTERNAL), state: null },
      { url: new URL(initialPath, ORIGIN), state: null },
    ];
    this.index = 1;
  }

  // ---- History API
  scrollRestoration: "auto" | "manual" = "auto";
  get length() {
    return this.entries.length;
  }
  get state() {
    return clone(this.entries[this.index].state);
  }
  pushState(state: unknown, _unused: string, url?: string | URL | null) {
    const next = url ? new URL(String(url), this.current.url) : this.current.url;
    this.entries.splice(this.index + 1);
    this.entries.push({ url: next, state: clone(state) });
    this.index += 1;
  }
  replaceState(state: unknown, _unused: string, url?: string | URL | null) {
    const next = url ? new URL(String(url), this.current.url) : this.current.url;
    this.entries[this.index] = { url: next, state: clone(state) };
  }
  go(delta = 0) {
    setTimeout(() => {
      const target = Math.max(0, Math.min(this.entries.length - 1, this.index + delta));
      if (target === this.index) return;
      this.index = target;
      // Like a DOM event: a listener can stop the ones registered after it.
      let stopped = false;
      const event = { type: "popstate", stopImmediatePropagation: () => void (stopped = true) };
      for (const l of [...this.listeners]) {
        if (stopped) break;
        l(event);
      }
    }, 0);
  }
  back() {
    this.go(-1);
  }
  forward() {
    this.go(1);
  }

  // ---- helpers
  get current() {
    return this.entries[this.index];
  }
  /** True once Back left the app (we are on the other site's page). */
  get exited() {
    return this.current.url.origin !== ORIGIN;
  }
  /** App entries as `path?query` (the external entry is skipped). */
  appUrls() {
    return this.entries.filter((e) => e.url.origin === ORIGIN).map((e) => e.url.pathname + e.url.search);
  }
  /** App entries up to the current one (what Back walks through; forward entries are left out). */
  backStack() {
    return this.entries
      .slice(0, this.index + 1)
      .filter((e) => e.url.origin === ORIGIN)
      .map((e) => e.url.pathname + e.url.search);
  }
  here() {
    return this.current.url.pathname + this.current.url.search;
  }

  addListener(fn: (e: PopEvent) => void) {
    this.listeners.add(fn);
  }
  removeListener(fn: (e: PopEvent) => void) {
    this.listeners.delete(fn);
  }
}

/** Installs `window`, `document` and `sessionStorage` globals backed by `history`. Returns an uninstall fn. */
export function installMemoryWindow(history: MemoryHistory): () => void {
  const g = globalThis as Record<string, unknown>;
  const saved = { window: g.window, document: g.document, sessionStorage: g.sessionStorage };
  const storage = new Map<string, string>();
  const sessionStorage = {
    getItem: (k: string) => storage.get(k) ?? null,
    setItem: (k: string, v: string) => void storage.set(k, String(v)),
    removeItem: (k: string) => void storage.delete(k),
    clear: () => storage.clear(),
  };
  const win = {
    history,
    get location() {
      const u = history.current.url;
      return { href: u.href, pathname: u.pathname, search: u.search, origin: u.origin };
    },
    addEventListener: (type: string, fn: (e: PopEvent) => void) => {
      if (type === "popstate") history.addListener(fn);
    },
    removeEventListener: (type: string, fn: (e: PopEvent) => void) => {
      if (type === "popstate") history.removeListener(fn);
    },
    setTimeout: (fn: () => void, ms?: number) => setTimeout(fn, ms) as unknown as number,
    clearTimeout: (h: number) => clearTimeout(h as unknown as NodeJS.Timeout),
    sessionStorage,
  };
  g.window = win;
  g.sessionStorage = sessionStorage;
  g.document = { documentElement: { dataset: {} as Record<string, string> } };
  return () => {
    g.window = saved.window;
    g.document = saved.document;
    g.sessionStorage = saved.sessionStorage;
  };
}

/** Lets queued traversals, popstates and the 300 ms fallback timers run. */
export async function settle(ms = 20) {
  for (let i = 0; i < 4; i++) await new Promise((r) => setTimeout(r, ms / 4));
}
