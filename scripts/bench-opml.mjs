#!/usr/bin/env node
/**
 * Launcher for the opt-in OPML/site benchmark (scripts/bench/bench-opml.mts).
 * The benchmark imports the app's TypeScript modules, so it runs under tsx
 * (downloaded on demand, not an app dependency). See scripts/bench/README.md.
 *
 *   node scripts/bench-opml.mjs --live --bundled --out bench-out/
 *   node scripts/bench-opml.mjs --live --opml my-feeds.opml --out bench-out/
 */
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const ci = String(process.env.CI || "").toLowerCase();
if (ci && !["0", "false"].includes(ci) && !process.argv.includes("--allow-ci")) {
  console.error("bench-opml refuses to run in CI (CI is set); pass --allow-ci to override deliberately");
  process.exit(1);
}
const script = fileURLToPath(new URL("./bench/bench-opml.mts", import.meta.url));
const result = spawnSync("pnpm", ["dlx", "tsx@4.23.15", script, ...process.argv.slice(2)], { stdio: "inherit" });
process.exit(result.status ?? 1);
