// Existing fetch fixtures remain usable after moving from Node's bundled undici
// to npm undici. Real socket tests use the original npm transport.
import { vi } from "vitest";
vi.mock("undici", async importOriginal => {
  const original = await importOriginal<typeof import("undici")>();
  return {
    ...original,
    fetch: (...args: Parameters<typeof original.fetch>) => vi.isMockFunction(globalThis.fetch)
      ? globalThis.fetch(String(args[0]), args[1] as RequestInit)
      : original.fetch(...args),
  };
});
