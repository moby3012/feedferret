import { defineConfig } from "vitest/config";
import path from "path";

export default defineConfig({
  test: {
    environment: "node",
    setupFiles: ["./tests/transport-setup.ts"],
    // Two projects: everything except *.timing.test.ts runs in parallel as before; timing tests
    // (hostile-input ReDoS growth checks) measure wall-clock, so they run alone and one file at a
    // time — `pnpm test` runs the projects one after the other (package.json), which keeps them
    // from starving other suites (and vice versa).
    projects: [
      { extends: true, test: { name: "unit", include: ["tests/**/*.test.ts"], exclude: ["tests/**/*.timing.test.ts", "**/node_modules/**"] } },
      { extends: true, test: { name: "timing", include: ["tests/**/*.timing.test.ts"], fileParallelism: false, maxWorkers: 1 } },
    ],
    // Bundles build/html-worker/worker.cjs once per run (lib/html-worker).
    globalSetup: ["./tests/html-worker-global-setup.ts"],
    env: {
      // Unit tests run the HTML tasks in-process so vi.mock() keeps applying;
      // tests/lib/html-worker*.test.ts exercise the real worker pool.
      FEEDFERRET_HTML_WORKER_INLINE: "1",
      // Enables the pool's __test* tasks (busy loop, memory bomb); refused in production.
      FEEDFERRET_HTML_WORKER_TEST_TASKS: "1",
    },
  },
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "."),
    },
  },
});
