import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MAX_ARTICLES_PER_CALL, MAX_WAIT_MS, StateBatcher, TRAILING_MS, toWireOps, type SettledFlush, type WireStateOp } from "../../features/articles/state-batcher";

function deferred<T>() {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

describe("StateBatcher", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  const setup = (send?: (ops: WireStateOp[]) => Promise<{ failed: string[] }>) => {
    const calls: WireStateOp[][] = [];
    const settled: SettledFlush[] = [];
    const batcher = new StateBatcher({
      send: (ops) => {
        calls.push(ops);
        return send ? send(ops) : Promise.resolve({ failed: [] });
      },
      onSettled: (r) => settled.push(r),
    });
    return { batcher, calls, settled };
  };

  it("coalesces writes into one call TRAILING_MS after the last enqueue (last write wins per field)", async () => {
    const { batcher, calls } = setup();
    batcher.enqueue({ id: "a", field: "isRead", value: true }, false);
    await vi.advanceTimersByTimeAsync(100);
    batcher.enqueue({ id: "b", field: "isStarred", value: true }, false);
    batcher.enqueue({ id: "a", field: "isStarred", value: true }, false);
    await vi.advanceTimersByTimeAsync(TRAILING_MS - 1);
    expect(calls).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(1);
    expect(calls).toEqual([[{ id: "a", isRead: true, isStarred: true }, { id: "b", isStarred: true }]]);
  });

  it("a toggle followed by its inverse cancels: nothing is sent", async () => {
    const { batcher, calls } = setup();
    for (let i = 0; i < 10; i++) batcher.enqueue({ id: "a", field: "isStarred", value: i % 2 === 0 }, i % 2 !== 0);
    expect(batcher.isIdle()).toBe(true);
    await vi.advanceTimersByTimeAsync(2000);
    expect(calls).toHaveLength(0);
  });

  it("an odd number of rapid toggles sends exactly one op with the final value", async () => {
    const { batcher, calls } = setup();
    for (let i = 0; i < 11; i++) batcher.enqueue({ id: "a", field: "isStarred", value: i % 2 === 0 }, i % 2 !== 0);
    await vi.advanceTimersByTimeAsync(TRAILING_MS);
    expect(calls).toEqual([[{ id: "a", isStarred: true }]]);
  });

  // Regression guard (mobile CI: 10 taps ~200 ms apart -> 10 calls). The
  // trailing window must outlast the gap between two rapid taps, or every tap
  // flushes alone and a toggle never meets its inverse in the queue.
  it.each([150, 200, 300])("toggles %i ms apart (rapid tap cadence) still cancel: nothing is sent", async (gapMs) => {
    const { batcher, calls } = setup();
    for (let i = 0; i < 10; i++) {
      batcher.enqueue({ id: "a", field: "isStarred", value: i % 2 === 0 }, i % 2 !== 0);
      await vi.advanceTimersByTimeAsync(gapMs);
    }
    await vi.advanceTimersByTimeAsync(2 * MAX_WAIT_MS);
    expect(calls).toHaveLength(0);
  });

  it("an odd number of toggles at tap cadence sends one op, even when tapping outlasts the max wait", async () => {
    const { batcher, calls } = setup();
    for (let i = 0; i < 11; i++) {
      batcher.enqueue({ id: "a", field: "isStarred", value: i % 2 === 0 }, i % 2 !== 0);
      await vi.advanceTimersByTimeAsync(250);
    }
    await vi.advanceTimersByTimeAsync(2 * MAX_WAIT_MS);
    expect(calls).toEqual([[{ id: "a", isStarred: true }]]);
  });

  it("the trailing window is longer than a rapid tap gap and shorter than the max wait", () => {
    expect(TRAILING_MS).toBeGreaterThanOrEqual(2 * 200);
    expect(TRAILING_MS).toBeLessThan(MAX_WAIT_MS);
  });

  it("flushes at the latest 1 s after the first enqueue even while writes keep coming", async () => {
    const { batcher, calls } = setup();
    for (let t = 0; t < 1200; t += 100) {
      batcher.enqueue({ id: `r${t}`, field: "isRead", value: true }, false);
      await vi.advanceTimersByTimeAsync(100);
    }
    expect(calls.length).toBe(1);
    expect(calls[0].length).toBe(10);
    await vi.advanceTimersByTimeAsync(TRAILING_MS);
    expect(calls.length).toBe(2);
  });

  it("flush() sends at once (page hidden)", async () => {
    const { batcher, calls } = setup();
    batcher.enqueue({ id: "a", field: "isReadLater", value: true }, false);
    batcher.flush();
    expect(calls).toEqual([[{ id: "a", isReadLater: true }]]);
  });

  it("keeps one call in flight; writes made meanwhile go in the next call, in order", async () => {
    const first = deferred<{ failed: string[] }>();
    let n = 0;
    const { batcher, calls } = setup(() => (n++ === 0 ? first.promise : Promise.resolve({ failed: [] })));
    batcher.enqueue({ id: "a", field: "isStarred", value: true }, false);
    batcher.flush();
    // Overlapping write of the same field while the first is in flight.
    batcher.enqueue({ id: "a", field: "isStarred", value: false }, true);
    batcher.flush();
    expect(calls).toHaveLength(1);
    expect(batcher.hasPending("a", "isStarred")).toBe(true);
    first.resolve({ failed: [] });
    await vi.advanceTimersByTimeAsync(0);
    expect(calls).toEqual([[{ id: "a", isStarred: true }], [{ id: "a", isStarred: false }]]);
  });

  it("reports ops the server did not apply, and all ops of a rejected call", async () => {
    let n = 0;
    const { batcher, settled } = setup(() => (n++ === 0 ? Promise.resolve({ failed: ["b"] }) : Promise.reject(new Error("offline"))));
    batcher.enqueue({ id: "a", field: "isRead", value: true }, false);
    batcher.enqueue({ id: "b", field: "isRead", value: true }, false);
    batcher.flush();
    await vi.advanceTimersByTimeAsync(0);
    expect(settled[0].failed).toEqual([{ id: "b", field: "isRead", value: true }]);
    batcher.enqueue({ id: "c", field: "isStarred", value: true }, false);
    batcher.flush();
    await vi.advanceTimersByTimeAsync(0);
    expect(settled[1].failed).toEqual([{ id: "c", field: "isStarred", value: true }]);
    expect(settled[1].error).toBeInstanceOf(Error);
  });

  it("whenIdle resolves after queued and in-flight writes settle", async () => {
    const call = deferred<{ failed: string[] }>();
    const { batcher } = setup(() => call.promise);
    let idle = false;
    batcher.enqueue({ id: "a", field: "isRead", value: true }, false);
    void batcher.whenIdle().then(() => (idle = true));
    await vi.advanceTimersByTimeAsync(TRAILING_MS);
    expect(idle).toBe(false);
    call.resolve({ failed: [] });
    await vi.advanceTimersByTimeAsync(0);
    expect(idle).toBe(true);
  });
});

describe("toWireOps", () => {
  it("merges the fields of one article into one op", () => {
    expect(
      toWireOps([
        { id: "a", field: "isRead", value: true },
        { id: "b", field: "isRead", value: false },
        { id: "a", field: "isReadLater", value: false },
      ]),
    ).toEqual([{ id: "a", isRead: true, isReadLater: false }, { id: "b", isRead: false }]);
  });
});

describe("StateBatcher limits and overlay", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  const setup = (send: (ops: WireStateOp[]) => Promise<{ failed: string[] }>) => {
    const calls: WireStateOp[][] = [];
    const batcher = new StateBatcher({ send: (ops) => { calls.push(ops); return send(ops); } });
    return { batcher, calls };
  };

  it("never sends more than the server cap per call; the rest follows right after", async () => {
    const d = deferred<{ failed: string[] }>();
    let first = true;
    const { batcher, calls } = setup(() => (first ? ((first = false), d.promise) : Promise.resolve({ failed: [] })));
    for (let i = 0; i < MAX_ARTICLES_PER_CALL + 50; i++) {
      batcher.enqueue({ id: `a${i}`, field: "isRead", value: true }, false);
      batcher.enqueue({ id: `a${i}`, field: "isStarred", value: true }, false);
    }
    batcher.flush();
    expect(calls).toHaveLength(1);
    expect(calls[0]).toHaveLength(MAX_ARTICLES_PER_CALL);
    expect(calls[0].every((op: WireStateOp) => op.isRead === true && op.isStarred === true)).toBe(true);
    d.resolve({ failed: [] });
    await vi.runAllTimersAsync();
    expect(calls).toHaveLength(2);
    expect(calls[1]).toHaveLength(50);
    await batcher.whenIdle();
  });

  it("reports the latest queued or in-flight value per field", async () => {
    const d = deferred<{ failed: string[] }>();
    const { batcher } = setup(() => d.promise);
    expect(batcher.latestValue("a", "isStarred")).toBeUndefined();
    batcher.enqueue({ id: "a", field: "isStarred", value: true }, false);
    expect(batcher.latestValue("a", "isStarred")).toBe(true);
    batcher.flush(); // now in flight
    expect(batcher.latestValue("a", "isStarred")).toBe(true);
    d.resolve({ failed: [] });
    await vi.runAllTimersAsync();
    expect(batcher.latestValue("a", "isStarred")).toBeUndefined();
  });
});
