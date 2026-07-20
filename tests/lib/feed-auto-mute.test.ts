import { describe, it, expect } from "vitest";
import { applySyncFailure, applySyncSuccess, applyManualUnmute } from "../../lib/feed-auto-mute";

describe("applySyncFailure", () => {
  it("increments the counter without muting while under the threshold", () => {
    const result = applySyncFailure({ consecutiveFailureCount: 2, autoMuted: false }, 10);
    expect(result).toEqual({ consecutiveFailureCount: 3, autoMuted: false, justMuted: false });
  });

  it("mutes and reports justMuted the exact sync that reaches the threshold", () => {
    const result = applySyncFailure({ consecutiveFailureCount: 9, autoMuted: false }, 10);
    expect(result).toEqual({ consecutiveFailureCount: 10, autoMuted: true, justMuted: true });
  });

  it("mutes when a failure jumps past the threshold in one step (e.g. threshold lowered)", () => {
    const result = applySyncFailure({ consecutiveFailureCount: 15, autoMuted: false }, 10);
    expect(result.autoMuted).toBe(true);
    expect(result.justMuted).toBe(true);
    expect(result.consecutiveFailureCount).toBe(16);
  });

  it("does not re-fire justMuted on a subsequent failure of an already-muted feed", () => {
    const result = applySyncFailure({ consecutiveFailureCount: 10, autoMuted: true }, 10);
    expect(result).toEqual({ consecutiveFailureCount: 11, autoMuted: true, justMuted: false });
  });

  it("never mutes when the threshold is 0 (disabled/opt-out), no matter how high the counter climbs", () => {
    const result = applySyncFailure({ consecutiveFailureCount: 99, autoMuted: false }, 0);
    expect(result).toEqual({ consecutiveFailureCount: 100, autoMuted: false, justMuted: false });
  });

  it("never mutes with a negative threshold either", () => {
    const result = applySyncFailure({ consecutiveFailureCount: 50, autoMuted: false }, -1);
    expect(result.autoMuted).toBe(false);
    expect(result.justMuted).toBe(false);
  });

  it("mutes at threshold 1 on the very first failure", () => {
    const result = applySyncFailure({ consecutiveFailureCount: 0, autoMuted: false }, 1);
    expect(result).toEqual({ consecutiveFailureCount: 1, autoMuted: true, justMuted: true });
  });
});

describe("applySyncSuccess", () => {
  it("resets the counter and clears the mute flag", () => {
    expect(applySyncSuccess()).toEqual({ consecutiveFailureCount: 0, autoMuted: false });
  });
});

describe("applyManualUnmute", () => {
  it("resets the counter and clears the mute flag, giving the feed one more chance", () => {
    expect(applyManualUnmute()).toEqual({ consecutiveFailureCount: 0, autoMuted: false });
  });
});
