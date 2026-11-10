import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PROBE_DELAYS_MS, createRecoveryProbe } from "@/features/offline/recovery";
import { checkServerSession } from "@/features/offline/verify";

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

describe("recovery probe (server back without an `online` event)", () => {
  it("probes with backoff, then reports recovery once and stops", async () => {
    const answers = [false, false, true];
    const probe = vi.fn(async () => answers.shift() ?? true);
    const onRecovered = vi.fn();
    const p = createRecoveryProbe({ probe, onRecovered, delays: [100, 200, 400] });
    p.start();
    expect(p.running).toBe(true);
    await vi.advanceTimersByTimeAsync(99);
    expect(probe).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1); // 100: first probe, still down
    expect(probe).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(199);
    expect(probe).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1); // +200: second
    expect(probe).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(400); // +400: third, up
    expect(probe).toHaveBeenCalledTimes(3);
    expect(onRecovered).toHaveBeenCalledTimes(1);
    expect(p.running).toBe(false);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(probe).toHaveBeenCalledTimes(3);
  });

  it("the last delay repeats; start() while running keeps the backoff position", async () => {
    const probe = vi.fn(async () => false);
    const p = createRecoveryProbe({ probe, onRecovered: vi.fn(), delays: [10, 20] });
    p.start();
    await vi.advanceTimersByTimeAsync(10 + 20 + 20 + 20);
    expect(probe).toHaveBeenCalledTimes(4);
    p.start(); // already running: no reset to the short delay
    await vi.advanceTimersByTimeAsync(19);
    expect(probe).toHaveBeenCalledTimes(4);
    p.stop();
  });

  it("stop() cancels, and a probe finishing after stop() does not report", async () => {
    let finish!: (v: boolean) => void;
    const onRecovered = vi.fn();
    const p = createRecoveryProbe({ probe: () => new Promise<boolean>((resolve) => (finish = resolve)), onRecovered, delays: [10] });
    p.start();
    await vi.advanceTimersByTimeAsync(10);
    p.stop();
    finish(true);
    await vi.advanceTimersByTimeAsync(10);
    expect(onRecovered).not.toHaveBeenCalled();
  });

  it("a throwing probe counts as unreachable", async () => {
    const probe = vi.fn().mockRejectedValueOnce(new Error("x")).mockResolvedValue(true);
    const onRecovered = vi.fn();
    createRecoveryProbe({ probe, onRecovered, delays: [10] }).start();
    await vi.advanceTimersByTimeAsync(10 + 10);
    expect(onRecovered).toHaveBeenCalledTimes(1);
  });

  it("starts at 3 s and backs off", () => {
    expect(PROBE_DELAYS_MS[0]).toBe(3000);
    expect([...PROBE_DELAYS_MS]).toEqual([...PROBE_DELAYS_MS].sort((a, b) => a - b));
  });
});

describe("checkServerSession", () => {
  const reply = (status: number, body?: unknown) => (async () => new Response(body === undefined ? null : JSON.stringify(body), { status })) as unknown as typeof fetch;
  it("maps the answers", async () => {
    expect(await checkServerSession("u1", reply(200, { userId: "u1" }))).toBe("ok");
    expect(await checkServerSession("u1", reply(200, { userId: "u2" }))).toBe("mismatch");
    expect(await checkServerSession("u1", reply(401))).toBe("unauthorized");
    expect(await checkServerSession("u1", reply(503))).toBe("unreachable");
    expect(await checkServerSession("u1", (async () => { throw new TypeError("Failed to fetch"); }) as unknown as typeof fetch)).toBe("unreachable");
  });
});
