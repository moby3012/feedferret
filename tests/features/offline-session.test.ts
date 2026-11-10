import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  getOfflineScope,
  getOfflineUser,
  isOfflineSessionExpired,
  noteSessionVerified,
  onOfflineScopeChange,
  resetOfflineSessionForTests,
  revokeOfflineScope,
  setOfflineGeneration,
  setOfflineUser,
  whenOfflineScope,
} from "@/features/offline/session";
import { OFFLINE_MAX_AGE_MS } from "@/features/offline/store";

beforeEach(() => resetOfflineSessionForTests());

describe("offline session state of a tab", () => {
  it("a user without a claimed generation has no write scope", () => {
    setOfflineUser("u1");
    expect(getOfflineUser()).toBe("u1");
    expect(getOfflineScope()).toBeNull();
    setOfflineGeneration("u1", "g1");
    expect(getOfflineScope()).toEqual({ userId: "u1", gen: "g1" });
  });

  it("a claim for a user that is not current any more is ignored", () => {
    setOfflineUser("u1");
    setOfflineUser("u2");
    expect(setOfflineGeneration("u1", "g1")).toBe(false);
    expect(getOfflineScope()).toBeNull();
  });

  it("revoking bumps first (listeners see no scope) and re-rendering does not bring the user back", () => {
    setOfflineUser("u1");
    setOfflineGeneration("u1", "g1");
    const seen: Array<unknown> = [];
    onOfflineScopeChange(() => seen.push(getOfflineScope()));
    revokeOfflineScope();
    expect(seen).toEqual([null]);
    setOfflineUser("u1"); // <OfflineSync> renders again after the query cache was cleared
    expect(getOfflineUser()).toBeNull();
    expect(getOfflineScope()).toBeNull();
  });

  it("whenOfflineScope waits for the claim and resolves null on revoke", async () => {
    setOfflineUser("u1");
    const waiting = whenOfflineScope();
    setOfflineGeneration("u1", "g1");
    expect(await waiting).toEqual({ userId: "u1", gen: "g1" });
    resetOfflineSessionForTests();
    setOfflineUser("u1");
    const second = whenOfflineScope();
    revokeOfflineScope();
    expect(await second).toBeNull();
  });

  it("whenOfflineScope gives up after the timeout", async () => {
    vi.useFakeTimers();
    setOfflineUser("u1");
    const waiting = whenOfflineScope(50);
    await vi.advanceTimersByTimeAsync(50);
    expect(await waiting).toBeNull();
    vi.useRealTimers();
  });

  it("expires when the server has not confirmed the session for the max age", () => {
    const t0 = 1_000_000_000_000;
    setOfflineUser("u1");
    expect(isOfflineSessionExpired(t0)).toBe(true); // not claimed yet
    setOfflineGeneration("u1", "g1", t0);
    expect(isOfflineSessionExpired(t0 + 1000)).toBe(false);
    expect(isOfflineSessionExpired(t0 + OFFLINE_MAX_AGE_MS + 1)).toBe(true);
    noteSessionVerified(t0 + OFFLINE_MAX_AGE_MS);
    expect(isOfflineSessionExpired(t0 + OFFLINE_MAX_AGE_MS + 1)).toBe(false);
  });
});
