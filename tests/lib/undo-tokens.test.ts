import { describe, it, expect, beforeEach } from "vitest";
import { claimUndoToken, clearUndoTokens, createUndoToken, discardUndoToken, MAX_IDS_PER_TOKEN, peekUndoToken, releaseUndoToken, UNDO_TOKEN_TTL_MS } from "../../lib/undo-tokens";

beforeEach(() => clearUndoTokens());

describe("undo tokens", () => {
  it("are random, url-safe and scoped to the creating user", () => {
    const a = createUndoToken("alice", ["1", "2", "2"])!;
    const b = createUndoToken("alice", ["3"]);
    expect(a).not.toBe(b);
    expect(a).toMatch(/^[A-Za-z0-9_-]{32,64}$/);
    expect(peekUndoToken("alice", a)).toEqual(["1", "2"]); // deduped
    expect(peekUndoToken("bob", a)).toBeNull();
  });

  it("expire after the TTL and can be discarded", () => {
    const now = 1_000_000;
    const t = createUndoToken("alice", ["1"], now)!;
    expect(peekUndoToken("alice", t, now + UNDO_TOKEN_TTL_MS - 1)).toEqual(["1"]);
    expect(peekUndoToken("alice", t, now + UNDO_TOKEN_TTL_MS)).toBeNull();
    const u = createUndoToken("alice", ["1"], now)!;
    discardUndoToken(u);
    expect(peekUndoToken("alice", u, now)).toBeNull();
  });

  it("reject non-string / malformed input", () => {
    for (const bad of [undefined, null, 5, ["a"], {}, "", "short", "x".repeat(65), "a b".padEnd(40, "c")]) {
      expect(peekUndoToken("alice", bad)).toBeNull();
    }
  });

  it("keep only the newest tokens per user", () => {
    const first = createUndoToken("alice", ["1"])!;
    for (let i = 0; i < 10; i++) createUndoToken("alice", [String(i)]);
    expect(peekUndoToken("alice", first)).toBeNull();
    const other = createUndoToken("bob", ["9"])!;
    for (let i = 0; i < 10; i++) createUndoToken("alice", [String(i)]);
    expect(peekUndoToken("bob", other)).toEqual(["9"]);
  });

  it("claims a token exactly once and can release it on failure", () => {
    const t = createUndoToken("alice", ["1"])!;
    const first = claimUndoToken("alice", t);
    expect(first?.ids).toEqual(["1"]);
    expect(claimUndoToken("alice", t)).toBeNull(); // concurrent second undo
    releaseUndoToken(t, first!);
    expect(claimUndoToken("bob", t)).toBeNull();
    expect(claimUndoToken("alice", t)?.ids).toEqual(["1"]);
  });

  it("refuses an undo token for oversized bulk actions without evicting others", () => {
    const keep = createUndoToken("alice", ["k"])!;
    const huge = Array.from({ length: MAX_IDS_PER_TOKEN + 1 }, (_, i) => String(i));
    expect(createUndoToken("alice", huge)).toBeNull();
    expect(createUndoToken("alice", [])).toBeNull();
    expect(peekUndoToken("alice", keep)).toEqual(["k"]);
  });
});
