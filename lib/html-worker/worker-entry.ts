// Entry point of the HTML worker thread (bundled by scripts/build-html-worker.mjs).
// One task at a time per worker; the pool terminates the thread on timeout.

import { parentPort } from "node:worker_threads";
import { runHtmlTaskInProcess, type HtmlTaskName } from "./tasks";

type Request = { id: number; task: HtmlTaskName; input: unknown };

if (!parentPort) throw new Error("html worker must run in a worker thread");
const port = parentPort;

port.on("message", async (request: Request) => {
  try {
    const result = await runHtmlTaskInProcess(request.task, request.input as never);
    port.postMessage({ id: request.id, ok: true, result });
  } catch (error) {
    const err = error instanceof Error ? error : new Error(String(error));
    port.postMessage({ id: request.id, ok: false, error: { name: err.name, message: err.message } });
  }
});

// Parsers are loaded (module graph evaluated): the pool starts task timers only now,
// so worker start-up never counts against a task's budget.
port.postMessage({ ready: true });
