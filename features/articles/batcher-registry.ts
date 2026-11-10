import type { QueryClient } from "@tanstack/react-query";
import type { StateBatcher } from "./state-batcher";

// One state batcher per QueryClient (i.e. per signed-in app instance). Lets
// non-React code (counts query, logout) wait for pending writes.
const registry = new WeakMap<QueryClient, StateBatcher>();

export function registerStateBatcher(qc: QueryClient, batcher: StateBatcher) {
  registry.set(qc, batcher);
}

export function unregisterStateBatcher(qc: QueryClient, batcher: StateBatcher) {
  if (registry.get(qc) === batcher) registry.delete(qc);
}

export function getStateBatcher(qc: QueryClient): StateBatcher | undefined {
  return registry.get(qc);
}
