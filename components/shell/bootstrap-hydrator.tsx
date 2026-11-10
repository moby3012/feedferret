import type { ReactNode } from "react";
import { headers } from "next/headers";
import { buildBootstrapState } from "@/server/bootstrap-state";
import { BootstrapCache } from "./bootstrap-cache";

/**
 * Server component: prefetches the shell's cold-start data and hands it to the
 * client cache (spec §2.5.2).
 *
 * Correctness does not depend on the request kind: `<BootstrapCache>` only
 * fills keys the client cache does not have, so a snapshot arriving with a
 * `router.refresh()` / soft navigation back to `/` can never overwrite live
 * (possibly optimistic) client state.
 *
 * Cost does: a router fetch finds the cache already filled, so the prefetch
 * is skipped when the browser's Fetch Metadata says so (`Sec-Fetch-Dest:
 * empty`; Next strips its own `RSC` header before app code can read it). A
 * request without the header (old browser, proxy that strips it) just pays for
 * a snapshot the client ignores.
 */
export async function BootstrapHydrator({ userId, href, children }: { userId: string; href: string; children: ReactNode }) {
  const isRouterFetch = (await headers()).get("sec-fetch-dest") === "empty";
  // Same element either way: a `router.refresh()` must not remount the shell.
  const state = isRouterFetch ? undefined : await buildBootstrapState(userId, href);
  return <BootstrapCache state={state}>{children}</BootstrapCache>;
}
