/**
 * N9: instance-wide import slots. Imports (FreshRSS ZIP/JSON migration, OPML)
 * parse untrusted uploads and write many rows; several at once would hold
 * hundreds of MB and saturate the database. At most `MAX_CONCURRENT_IMPORTS`
 * run per process (env `FEEDFERRET_MAX_CONCURRENT_IMPORTS`, default 1, max 16);
 * one user never holds more than one.
 *
 * In-process only, like the rate limiter: a multi-instance deployment gets one
 * pool per instance.
 */

const DEFAULT_MAX_CONCURRENT_IMPORTS = 1;
const MAX_CONFIGURABLE_IMPORTS = 16;

export function maxConcurrentImports(): number {
  const raw = Number(process.env.FEEDFERRET_MAX_CONCURRENT_IMPORTS);
  if (!Number.isSafeInteger(raw) || raw < 1) return DEFAULT_MAX_CONCURRENT_IMPORTS;
  return Math.min(raw, MAX_CONFIGURABLE_IMPORTS);
}

/** Seconds a client is told to wait (`Retry-After`) when every slot is taken. */
export const IMPORT_BUSY_RETRY_SECS = 60;

export class ImportBusyError extends Error {
  constructor(readonly reason: "instance" | "user") {
    super(reason === "user" ? "Another import is still running" : "Import busy, retry in a minute");
    this.name = "ImportBusyError";
  }
}

/** 409 (this user's import still runs) or 429 + Retry-After (instance busy). */
export function importBusyResponse(error: ImportBusyError): Response {
  const status = error.reason === "user" ? 409 : 429;
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (status === 429) headers["Retry-After"] = String(IMPORT_BUSY_RETRY_SECS);
  return new Response(JSON.stringify({ error: { message: error.message } }), { status, headers });
}

const running = new Set<string>();
let active = 0;
const waiters: Array<() => void> = [];

export type ReleaseImportSlot = () => void;

function take(userId: string): ReleaseImportSlot {
  active += 1;
  running.add(userId);
  let released = false;
  return () => {
    if (released) return;
    released = true;
    active -= 1;
    running.delete(userId);
    waiters.shift()?.();
  };
}

/**
 * Takes a slot for `userId`, or throws `ImportBusyError`: `user` when this user
 * already runs an import, `instance` when every slot is taken (after waiting up
 * to `waitMs` for one to free up; 0 = fail fast). Always call the returned
 * release function (in a `finally`).
 */
export async function acquireImportSlot(userId: string, options: { waitMs?: number } = {}): Promise<ReleaseImportSlot> {
  if (running.has(userId)) throw new ImportBusyError("user");
  const deadline = Date.now() + Math.max(0, options.waitMs ?? 0);
  while (active >= maxConcurrentImports()) {
    const left = deadline - Date.now();
    if (left <= 0) throw new ImportBusyError("instance");
    await new Promise<void>((resolve) => {
      const timer = setTimeout(() => {
        const at = waiters.indexOf(wake);
        if (at >= 0) waiters.splice(at, 1);
        resolve();
      }, left);
      const wake = () => {
        clearTimeout(timer);
        resolve();
      };
      waiters.push(wake);
    });
    if (running.has(userId)) throw new ImportBusyError("user");
  }
  return take(userId);
}

/** Runs `fn` while holding an import slot (see `acquireImportSlot`). */
export async function withImportSlot<T>(userId: string, fn: () => Promise<T>, options: { waitMs?: number } = {}): Promise<T> {
  const release = await acquireImportSlot(userId, options);
  try {
    return await fn();
  } finally {
    release();
  }
}

/** Test hook: current slot usage. */
export function importSlotUsage(): { active: number; users: string[] } {
  return { active, users: [...running] };
}
