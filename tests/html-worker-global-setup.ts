// Vitest global setup: bundle the HTML worker (lib/html-worker) so the pool
// tests run against the same artefact production loads.
import { execFileSync } from "node:child_process";
import path from "node:path";

export default function setup() {
  execFileSync(process.execPath, [path.join(__dirname, "..", "scripts", "build-html-worker.mjs")], { stdio: "inherit" });
}
