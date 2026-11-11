#!/usr/bin/env node
// Bundles the HTML worker thread (lib/html-worker/worker-entry.ts) into
// build/html-worker/worker.mjs. Next.js does not bundle worker_threads
// scripts, so the worker is its own artefact: built by `pnpm run build`
// (and `pnpm dev`, the vitest global setup), copied into the Docker image next
// to server.js and loaded by lib/html-worker/pool.ts.
//
// jsdom stays external (it resolves files relative to itself at runtime and is
// shipped in the standalone node_modules because the main app imports it);
// everything else is bundled. The build FAILS when an I/O module (DB, SSRF
// fetch, auth, Next) leaks into the worker graph: the worker must stay a pure
// parser with no access to the database or the network.
import { build } from "esbuild";
import { mkdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const outfile = path.join(root, "build", "html-worker", "worker.mjs");
const watch = process.argv.includes("--watch");

const FORBIDDEN_INPUTS = [
  /^lib\/db\.ts$/,
  /^lib\/ssrf\.ts$/,
  /^lib\/prisma-client\//,
  /^lib\/render-sidecar\.ts$/,
  /^lib\/hosted-fetch\.ts$/,
  /^lib\/crypto\.ts$/,
  /^lib\/secret-box/,
  /^auth\.ts$/,
  /node_modules\/(?:\.pnpm\/[^/]+\/node_modules\/)?(?:next|@prisma|undici|impit|pg|better-sqlite3)\//,
];

mkdirSync(path.dirname(outfile), { recursive: true });
const started = Date.now();
const result = await build({
  absWorkingDir: root,
  entryPoints: ["lib/html-worker/worker-entry.ts"],
  outfile,
  bundle: true,
  platform: "node",
  target: "node22",
  format: "esm",
  external: ["jsdom", "canvas", "bufferutil", "utf-8-validate"],
  // CommonJS dependencies bundled into an ES module still call require() for Node built-ins.
  banner: { js: "import { createRequire as __ffCreateRequire } from 'node:module'; const require = __ffCreateRequire(import.meta.url);" },
  sourcemap: false,
  legalComments: "none",
  metafile: true,
  logLevel: "warning",
  tsconfig: path.join(root, "tsconfig.json"),
});

const leaked = Object.keys(result.metafile.inputs).filter((input) => FORBIDDEN_INPUTS.some((re) => re.test(input)));
if (leaked.length > 0) {
  console.error(`[build-html-worker] forbidden modules in the worker graph:\n  ${leaked.join("\n  ")}`);
  process.exit(1);
}
const bytes = result.metafile.outputs[path.relative(root, outfile)]?.bytes ?? 0;
console.log(`[build-html-worker] ${path.relative(root, outfile)} (${(bytes / 1024).toFixed(0)} KiB, ${Date.now() - started} ms)`);
if (watch) console.log("[build-html-worker] --watch is not supported; rebuild after changing worker code");
