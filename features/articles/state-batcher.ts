// Coalescing write queue for hot article toggles (.pm/spec-shell-design.md §2.4).
//
// The cache is patched optimistically first; the batcher only decides WHAT
// reaches the server and WHEN:
// - per (article, field) the last write wins; a toggle followed by its inverse
//   cancels out before anything is sent,
// - flush 150 ms after the last enqueue (trailing), at the latest 1 s after
//   the first one, or immediately via `flush()` (page hidden),
// - one call per flush, at most one call in flight (later ops wait for it, so
//   the server sees writes of one field in order),
// - after each call `onSettled` gets the ops the server did not apply
//   (rejected call → all of them) so the caller can roll back per field.
// Pure TypeScript (timers injectable) so it is unit-testable without React.

export type StateField = "isRead" | "isStarred" | "isReadLater";

export interface StateOp {
  id: string;
  field: StateField;
  value: boolean;
}

/** Wire shape of one article's ops (`applyArticleStateOps`). */
export type WireStateOp = { id: string } & Partial<Record<StateField, boolean>>;

export interface SettledFlush {
  ops: StateOp[];
  failed: StateOp[];
  /** Set when the whole call was rejected (network, server error). */
  error?: unknown;
}

export interface StateBatcherOptions {
  send(ops: WireStateOp[]): Promise<{ failed: string[] }>;
  onSettled?(result: SettledFlush): void;
  trailingMs?: number;
  maxMs?: number;
  setTimer?(fn: () => void, ms: number): unknown;
  clearTimer?(handle: unknown): void;
}

type Pending = { op: StateOp; base: boolean };

const keyOf = (id: string, field: StateField) => `${id}\u0000${field}`;

/** Server cap per call (`applyArticleStateOps`, one wire op per article). */
export const MAX_ARTICLES_PER_CALL = 200;

export function toWireOps(ops: StateOp[]): WireStateOp[] {
  const byId = new Map<string, WireStateOp>();
  for (const op of ops) {
    const wire = byId.get(op.id) ?? { id: op.id };
    wire[op.field] = op.value;
    byId.set(op.id, wire);
  }
  return [...byId.values()];
}

export class StateBatcher {
  private readonly pending = new Map<string, Pending>();
  private inFlight = false;
  private inFlightOps: StateOp[] = [];
  private flushWhenSettled = false;
  private trailingTimer: unknown = null;
  private maxTimer: unknown = null;
  private idleWaiters: Array<() => void> = [];
  private readonly trailingMs: number;
  private readonly maxMs: number;
  private readonly setTimer: (fn: () => void, ms: number) => unknown;
  private readonly clearTimer: (handle: unknown) => void;

  constructor(private readonly options: StateBatcherOptions) {
    this.trailingMs = options.trailingMs ?? 150;
    this.maxMs = options.maxMs ?? 1000;
    this.setTimer = options.setTimer ?? ((fn, ms) => setTimeout(fn, ms));
    this.clearTimer = options.clearTimer ?? ((handle) => clearTimeout(handle as ReturnType<typeof setTimeout>));
  }

  /**
   * Queues `op`. `previous` is the value the field held before this optimistic
   * write; when the field goes back to the value it had before the first
   * queued write, the pair cancels and nothing is sent.
   */
  enqueue(op: StateOp, previous: boolean) {
    const key = keyOf(op.id, op.field);
    const existing = this.pending.get(key);
    if (existing) {
      if (existing.base === op.value) this.pending.delete(key);
      else existing.op = op;
    } else if (previous !== op.value) {
      this.pending.set(key, { op, base: previous });
    }
    this.schedule();
  }

  /**
   * The value the user last set for this field that the server may not have
   * yet (queued, or sent and not settled). Used to overlay fetched data so a
   * response that raced a write never brings back the old flag.
   */
  latestValue(id: string, field: StateField): boolean | undefined {
    const queued = this.pending.get(keyOf(id, field));
    if (queued) return queued.op.value;
    for (let i = this.inFlightOps.length - 1; i >= 0; i--) {
      const op = this.inFlightOps[i];
      if (op.id === id && op.field === field) return op.value;
    }
    return undefined;
  }

  /** A write for this field is queued (not yet sent). */
  hasPending(id: string, field: StateField): boolean {
    return this.pending.has(keyOf(id, field));
  }

  isIdle(): boolean {
    return this.pending.size === 0 && !this.inFlight;
  }

  /** Resolves once nothing is queued or in flight. */
  whenIdle(): Promise<void> {
    if (this.isIdle()) return Promise.resolve();
    return new Promise((resolve) => this.idleWaiters.push(resolve));
  }

  /** Sends everything queued now (or right after the call in flight). */
  flush() {
    this.clearTimers();
    if (this.pending.size === 0) {
      this.notifyIdle();
      return;
    }
    if (this.inFlight) {
      this.flushWhenSettled = true;
      return;
    }
    // At most MAX_ARTICLES_PER_CALL articles per call; the rest is sent right
    // after this call settles (the server would reject an oversized call whole).
    const ops: StateOp[] = [];
    const ids = new Set<string>();
    for (const [key, p] of this.pending) {
      if (!ids.has(p.op.id) && ids.size >= MAX_ARTICLES_PER_CALL) continue;
      ids.add(p.op.id);
      ops.push(p.op);
      this.pending.delete(key);
    }
    if (this.pending.size > 0) this.flushWhenSettled = true;
    this.inFlight = true;
    this.inFlightOps = ops;
    let settled: SettledFlush;
    void this.options
      .send(toWireOps(ops))
      .then(
        (result) => {
          const failedIds = new Set(result?.failed ?? []);
          settled = { ops, failed: ops.filter((op) => failedIds.has(op.id)) };
        },
        (error: unknown) => {
          settled = { ops, failed: ops, error };
        },
      )
      .then(() => {
        this.inFlight = false;
        this.inFlightOps = [];
        try {
          this.options.onSettled?.(settled);
        } finally {
          if (this.flushWhenSettled) {
            this.flushWhenSettled = false;
            this.flush();
          } else if (this.pending.size > 0) {
            this.schedule();
          } else {
            this.notifyIdle();
          }
        }
      });
  }

  private schedule() {
    if (this.pending.size === 0) {
      this.clearTimers();
      this.notifyIdle();
      return;
    }
    if (this.trailingTimer !== null) this.clearTimer(this.trailingTimer);
    this.trailingTimer = this.setTimer(() => this.flush(), this.trailingMs);
    if (this.maxTimer === null) this.maxTimer = this.setTimer(() => this.flush(), this.maxMs);
  }

  private clearTimers() {
    if (this.trailingTimer !== null) this.clearTimer(this.trailingTimer);
    if (this.maxTimer !== null) this.clearTimer(this.maxTimer);
    this.trailingTimer = null;
    this.maxTimer = null;
  }

  private notifyIdle() {
    if (!this.isIdle()) return;
    const waiters = this.idleWaiters;
    this.idleWaiters = [];
    waiters.forEach((resolve) => resolve());
  }
}
