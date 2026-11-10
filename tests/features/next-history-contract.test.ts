// Contract with Next's app router history handling (installed version).
//
// The shell (features/reader/nav/history.ts) relies on private, undocumented
// behaviour of Next's app router:
//   - entries the router can restore carry `__NA` (+ `__PRIVATE_NEXTJS_INTERNALS_TREE`);
//     a popstate onto an entry without `__NA` RELOADS the page;
//   - Next's pushState/replaceState patch copies those keys into our writes and
//     mirrors the URL into the router (restore) — unless the data already has
//     `__NA`/`_N`, which is why we never pass them while the patch is installed;
//   - Next's own writes are recognisable by `__NA` and keep custom state (our
//     `ff`) only for a restore/traverse (`preserveCustomHistoryState`), which
//     is what keepFfAcrossRouterWrites() discriminates on.
//
// If a Next upgrade changes any of this, this test fails BEFORE users get
// reloads on Back or a lost stack depth. On failure: re-read the files named
// below, re-verify history.ts (header + keepFfAcrossRouterWrites) and the e2e
// specs navigation / nav-router-interop, then update this test.
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { NEXT_KEYS } from "../../features/reader/nav/history";

/** Next major.minor versions the history contract below was verified against. */
const VERIFIED = ["16.4"];

const require = createRequire(import.meta.url);
const nextPkg = require.resolve("next/package.json");
const nextVersion = (JSON.parse(readFileSync(nextPkg, "utf8")) as { version: string }).version;
const source = (rel: string) => readFileSync(path.join(path.dirname(nextPkg), "dist/client/components", rel), "utf8").replace(/\s+/g, " ");

describe(`Next ${nextVersion} history-state contract`, () => {
  it("runs against a verified Next major.minor", () => {
    const majorMinor = nextVersion.split(".").slice(0, 2).join(".");
    expect(
      VERIFIED,
      `Next ${nextVersion} is not verified against the shell's history contract — re-check features/reader/nav/history.ts, then add "${majorMinor}" to VERIFIED`,
    ).toContain(majorMinor);
  });

  const appRouter = source("app-router.js");

  it("popstate: entries without __NA reload, others are traversed with the stored tree", () => {
    expect(appRouter).toContain("if (!state.__NA) { window.location.reload();");
    expect(appRouter).toMatch(/traverse\)\(window\.location\.href, state\.__PRIVATE_NEXTJS_INTERNALS_TREE\)/);
  });

  it("history patch: passes writes with __NA/_N through, copies Next's keys into all others and restores their URL", () => {
    expect(appRouter.match(/if \(data\?\.__NA \|\| data\?\._N\) \{ return original(Push|Replace)State\(data, _unused, url\);/g)).toHaveLength(2);
    expect(appRouter).toContain("data.__NA = __NA;");
    expect(appRouter).toContain("data.__PRIVATE_NEXTJS_INTERNALS_TREE = __PRIVATE_NEXTJS_INTERNALS_TREE;");
    expect(appRouter).toMatch(/applyUrlFromHistoryPushReplace = \(url\)=>\{.*?restore\)\(new URL\(url \?\? href, href\), appHistoryState\);/);
  });

  it("router writes: always carry __NA, keep custom state only when preserveCustomHistoryState", () => {
    expect(appRouter).toContain("...pushRef.preserveCustomHistoryState ? window.history.state : {}, // Identifier is shortened intentionally.");
    expect(appRouter).toMatch(/__NA: true, __PRIVATE_NEXTJS_INTERNALS_TREE: appHistoryState \};/);
  });

  it("restore/traverse commits preserve custom state (the URL-preserving guard keys on it)", () => {
    expect(source("app-router-state.js")).toMatch(/function completeTraverseNavigation\(.*?preserveCustomHistoryState: true/);
  });

  it("every key we treat as Next's is one Next uses", () => {
    for (const key of NEXT_KEYS) expect(appRouter, key).toContain(key);
  });
});
