#!/usr/bin/env node
// Bundles the HTML worker thread (lib/html-worker/worker-entry.ts) into
// build/html-worker/worker.cjs. Next.js does not bundle worker_threads
// scripts, so the worker is its own artefact: built by `pnpm run build`
// (and `pnpm dev`, the vitest global setup), copied into the Docker image next
// to server.js and loaded by lib/html-worker/pool.ts.
//
// The bundle is SELF-CONTAINED, jsdom included: the main app no longer imports
// any parser (ESLint boundary, #281), so Next's standalone tracing would not
// ship jsdom for an external import. Two jsdom files need help (plugin below):
// the default stylesheet is read from disk via __dirname (inlined instead) and
// the sync-XHR helper is located with require.resolve at load time (sync XHR
// is never used here: disabled). Only optional native add-ons stay external.
// The build FAILS when an I/O module (DB, SSRF fetch, auth, Next) leaks into
// the worker graph: the worker must stay a pure parser with no access to the
// database or the network.
import { build } from "esbuild";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const outfile = path.join(root, "build", "html-worker", "worker.cjs");
const watch = process.argv.includes("--watch");

// Our own I/O modules may never be part of the worker graph.
const FORBIDDEN_INPUTS = [
  /^lib\/db\.ts$/,
  /^lib\/ssrf\.ts$/,
  /^lib\/prisma-client\//,
  /^lib\/render-sidecar\.ts$/,
  /^lib\/hosted-fetch\.ts$/,
  /^lib\/crypto\.ts$/,
  /^lib\/secret-box/,
  /^auth\.ts$/,
];
// Network / DB / framework packages our code must not import from the worker.
// (jsdom carries its own HTTP client for resource loading — undici in jsdom
// 30 — which is bundled but never used: no JSDOM is created with `resources`.
// Only a DIRECT import from our lib/ code counts.)
const FORBIDDEN_PACKAGES = /^(?:next|@prisma\/[^/]+|undici|impit|pg|better-sqlite3|node:https?|https?|net|tls|dgram)(?:\/|$)/;

/**
 * Makes jsdom bundleable (every copy in the graph: isomorphic-dompurify pulls
 * its own jsdom version). Two load-time file-system accesses relative to
 * jsdom's own directory cannot survive bundling:
 *   - the default stylesheet read via `fs.readFileSync(path.resolve(__dirname, …))`
 *     is inlined as a string literal,
 *   - the sync-XHR helper located via `require.resolve("./xhr-sync-worker.js")`
 *     becomes `null` (synchronous XHR is never used by the parsers).
 * The output is checked afterwards so a jsdom upgrade that changes either
 * spelling fails the build instead of the worker at runtime.
 */
const STYLESHEET_READ = /fs\.readFileSync\(\s*path\.resolve\(\s*__dirname,\s*"([^"]*default-stylesheet\.css)"\s*\),\s*\{\s*encoding:\s*"utf-8"\s*\}\s*\)/;
const SYNC_XHR_RESOLVE = /require\.resolve\s*\?\s*require\.resolve\("\.\/xhr-sync-worker\.js"\)\s*:\s*null|require\.resolve\("\.\/xhr-sync-worker\.js"\)/;
function jsdomStaticAssets() {
  return {
    name: "jsdom-static-assets",
    setup(b) {
      b.onLoad({ filter: /[\\/]jsdom[\\/]lib[\\/].*\.js$/ }, (args) => {
        const source = readFileSync(args.path, "utf8");
        if (!STYLESHEET_READ.test(source) && !SYNC_XHR_RESOLVE.test(source)) return undefined;
        const contents = source
          .replace(STYLESHEET_READ, (_m, rel) => JSON.stringify(readFileSync(path.resolve(path.dirname(args.path), rel), "utf8")))
          .replace(SYNC_XHR_RESOLVE, "null");
        return { contents, loader: "js" };
      });
    },
  };
}

mkdirSync(path.dirname(outfile), { recursive: true });
// The app's tsconfig (paths: "@/…") minus `alwaysStrict`, which esbuild would
// otherwise apply to EVERY bundled file, node_modules included: it inserts
// "use strict" into each CommonJS wrapper, and @acemir/cssom (jsdom's CSS
// layer) assigns to a getter-only property (a no-op in sloppy mode, as under
// Node, but a TypeError in strict mode: <style> handling broke in the bundle).
const workerTsconfig = path.join(root, "build", "tsconfig.html-worker.json"); // not shipped (only build/html-worker is)
writeFileSync(workerTsconfig, JSON.stringify({ extends: path.join(root, "tsconfig.json"), compilerOptions: { alwaysStrict: false } }, null, 2));
const started = Date.now();
const result = await build({
  absWorkingDir: root,
  entryPoints: ["lib/html-worker/worker-entry.ts"],
  outfile,
  bundle: true,
  platform: "node",
  target: "node22",
  // CommonJS, not ESM: an ES module is strict-mode code throughout, and some
  // bundled CommonJS dependencies (jsdom's CSS layer) assign to getter-only
  // properties, which is a silent no-op in sloppy mode but a TypeError in
  // strict mode (see the file-wide directive handling below).
  format: "cjs",
  // Optional native add-ons, loaded inside try/catch by jsdom / ws.
  external: ["canvas", "bufferutil", "utf-8-validate"],
  plugins: [jsdomStaticAssets()],
  sourcemap: false,
  legalComments: "none",
  metafile: true,
  logLevel: "warning",
  tsconfig: workerTsconfig,
});

// esbuild also puts a file-wide "use strict" on a CommonJS bundle whose entry
// is an ES module, which would force the same strictness on every bundled
// CommonJS dependency. Under Node each such file keeps its own mode (files
// that declare "use strict" keep it inside their wrapper), so drop it.
let bundled = readFileSync(outfile, "utf8");
const FILE_WIDE_STRICT = '"use strict";\n';
if (bundled.startsWith(FILE_WIDE_STRICT)) {
  bundled = bundled.slice(FILE_WIDE_STRICT.length);
  writeFileSync(outfile, bundled);
}
for (const [what, re] of [["jsdom default-stylesheet read", /default-stylesheet\.css"\s*\)/], ["jsdom xhr-sync-worker lookup", /xhr-sync-worker\.js"\)/], ["__dirname", /\b__dirname\b/]]) {
  if (re.test(bundled)) {
    console.error(`[build-html-worker] ${what} left in the bundle: it would fail at runtime outside node_modules`);
    process.exit(1);
  }
}
const inputs = result.metafile.inputs;
const leaked = [
  ...Object.keys(inputs).filter((input) => FORBIDDEN_INPUTS.some((re) => re.test(input))),
  ...Object.entries(inputs)
    .filter(([file]) => file.startsWith("lib/"))
    .flatMap(([file, info]) =>
      info.imports.filter((imp) => FORBIDDEN_PACKAGES.test(imp.original ?? "")).map((imp) => `${file} -> ${imp.original}`),
    ),
];
if (leaked.length > 0) {
  console.error(`[build-html-worker] forbidden modules in the worker graph:\n  ${leaked.join("\n  ")}`);
  process.exit(1);
}
const bytes = result.metafile.outputs[path.relative(root, outfile)]?.bytes ?? 0;
console.log(`[build-html-worker] ${path.relative(root, outfile)} (${(bytes / 1024).toFixed(0)} KiB, ${Date.now() - started} ms)`);
if (watch) console.log("[build-html-worker] --watch is not supported; rebuild after changing worker code");
