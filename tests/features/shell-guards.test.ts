import { describe, expect, it } from "vitest";
import { createDraftCommitter } from "../../components/shell/search-draft";
import { MAX_RESTORE_LOADS, planRestore } from "../../features/reader/nav/scroll-memory";
import { SYSTEM_EDGE_PX, startsAtSystemEdge } from "../../lib/gesture-guards";
import { THEME_COLOR, themeColorFor } from "../../lib/theme-color";

describe("scroll restoration reveals / loads through the anchor row", () => {
  const ids = Array.from({ length: 100 }, (_, i) => `a${i}`);
  const paging = { hasMorePages: false, isFetching: false, loads: 0 };

  it("anchor inside the initial window: restore right away", () => {
    expect(planRestore({ top: 900, anchorId: "a12", anchorOffset: 4 }, ids, 30, paging)).toEqual({ kind: "ready" });
  });
  it("anchor beyond the initial 30 rows: reveal through it first, then restore", () => {
    const pos = { top: 6000, anchorId: "a75", anchorOffset: 0 };
    expect(planRestore(pos, ids, 30, paging)).toEqual({ kind: "reveal", count: 76 });
    expect(planRestore(pos, ids, 76, paging)).toEqual({ kind: "ready" });
  });
  it("anchor not loaded yet: page in (bounded), waiting while a page is in flight", () => {
    const pos = { top: 12000, anchorId: "b40" };
    const more = { hasMorePages: true, isFetching: false, loads: 0 };
    expect(planRestore(pos, ids, 30, more)).toEqual({ kind: "load" });
    expect(planRestore(pos, ids, 30, { ...more, isFetching: true })).toEqual({ kind: "wait" });
    // Gave up after MAX_RESTORE_LOADS pages: fall back to the raw offset over every loaded row.
    expect(planRestore(pos, ids, 30, { ...more, loads: MAX_RESTORE_LOADS })).toEqual({ kind: "reveal", count: 100 });
  });
  it("anchor gone (read in an unread-only list) / no anchor: raw offset needs every loaded row", () => {
    expect(planRestore({ top: 5000, anchorId: "gone" }, ids, 30, paging)).toEqual({ kind: "reveal", count: 100 });
    expect(planRestore({ top: 5000 }, ids, 100, paging)).toEqual({ kind: "ready" });
  });
  it("nothing remembered / top 0 / no rows", () => {
    expect(planRestore(undefined, ids, 30, paging)).toEqual({ kind: "ready" });
    expect(planRestore({ top: 0 }, ids, 30, paging)).toEqual({ kind: "ready" });
    expect(planRestore({ top: 400, anchorId: "a1" }, [], 30, { ...paging, isFetching: true })).toEqual({ kind: "wait" });
  });
});

describe("inline search draft commit", () => {
  function harness() {
    const timers: { fn: () => void; at: number; id: number }[] = [];
    let now = 0;
    let seq = 0;
    const commits: string[] = [];
    const committer = createDraftCommitter({
      commit: (t) => commits.push(t),
      committed: () => "",
      setTimer: (fn, ms) => {
        const id = ++seq;
        timers.push({ fn, at: now + ms, id });
        return id;
      },
      clearTimer: (id) => {
        const i = timers.findIndex((t) => t.id === id);
        if (i >= 0) timers.splice(i, 1);
      },
    });
    const advance = (ms: number) => {
      now += ms;
      for (const t of timers.filter((t) => t.at <= now)) {
        timers.splice(timers.indexOf(t), 1);
        t.fn();
      }
    };
    return { committer, commits, advance };
  }

  it("commits 300 ms after the last keystroke", () => {
    const { committer, commits, advance } = harness();
    committer.edit("ru");
    advance(200);
    committer.edit("rust ");
    advance(299);
    expect(commits).toEqual([]);
    advance(1);
    expect(commits).toEqual(["rust"]);
  });
  it("a dismissal (system Back within 300 ms) cancels the pending commit", () => {
    const { committer, commits, advance } = harness();
    committer.edit("cancelled");
    advance(100);
    expect(committer.pending).toBe(true);
    committer.cancel(); // what useSearchCommit does on a pop-os / pop-ui nav change
    advance(1000);
    expect(commits).toEqual([]);
    expect(committer.pending).toBe(false);
  });
});

describe("reader swipe-back leaves the OS edge band alone", () => {
  it("touches within 24 px of either edge are the system's back gesture", () => {
    expect(SYSTEM_EDGE_PX).toBe(24);
    expect(startsAtSystemEdge(0, 390)).toBe(true);
    expect(startsAtSystemEdge(23, 390)).toBe(true);
    expect(startsAtSystemEdge(24, 390)).toBe(false);
    expect(startsAtSystemEdge(200, 390)).toBe(false);
    expect(startsAtSystemEdge(380, 390)).toBe(true); // RTL edge
  });
});

describe("theme-color follows the resolved (persisted) theme", () => {
  it("maps dark / light / unknown", () => {
    expect(themeColorFor("dark")).toBe(THEME_COLOR.dark);
    expect(themeColorFor("light")).toBe(THEME_COLOR.light);
    expect(themeColorFor(undefined)).toBe(THEME_COLOR.light);
  });
});
