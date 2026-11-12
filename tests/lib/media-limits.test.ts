import { expect, it, vi } from "vitest";
import { MediaTransferLimiter } from "@/lib/media-limits";
it("enforces per-user and global concurrency and releases idempotently", () => {
  const limits = new MediaTransferLimiter(() => 100, 3, 2);
  const a = limits.acquire("a"), b = limits.acquire("a"), c = limits.acquire("b");
  expect(limits.acquire("a")).toEqual({ status: 429 });
  expect(limits.acquire("c")).toEqual({ status: 503 });
  if (!("status" in a)) { a.release(); a.release(); }
  expect(limits.acquire("c")).not.toHaveProperty("status");
  expect(limits.acquire("d")).toEqual({ status: 503 });
  if (!("status" in b)) b.release();
  if (!("status" in c)) c.release();
});
it("accounts streamed bytes across requests and resets the hourly budget", () => {
  const limits = new MediaTransferLimiter(() => 100);
  const first = limits.acquire("a");
  if ("status" in first) throw new Error("unexpected refusal");
  expect(first.charge(70)).toBe(true);
  first.release();
  const next = limits.acquire("a");
  if ("status" in next) throw new Error("unexpected refusal");
  expect(next.charge(31)).toBe(false);
  next.release();
  expect(limits.acquire("a")).toEqual({ status: 429 });
  expect(limits.acquire("b")).not.toHaveProperty("status");
  const clock = vi.spyOn(Date, "now").mockReturnValue(Date.now() + 3_600_001);
  expect(limits.acquire("a")).not.toHaveProperty("status");
  clock.mockRestore();
});
