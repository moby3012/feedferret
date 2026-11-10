import type { ReactNode } from "react";
import { headers } from "next/headers";
import { HydrationBoundary } from "@tanstack/react-query";
import { buildBootstrapState } from "@/server/bootstrap-state";

/**
 * Server component: prefetches the shell's cold-start data and hands it to the
 * client cache (spec §2.5.2). Only for document loads: an RSC fetch of the
 * router (soft navigation back from /settings, `router.refresh()`) finds a
 * live client cache that is newer and may hold optimistic state a server
 * snapshot must not clobber.
 *
 * Next strips its own `RSC` request header before app code (and the proxy)
 * can read it, so the browser's Fetch Metadata tells the two apart: the
 * router fetches (`Sec-Fetch-Dest: empty`), a page load navigates
 * (`document`). Without the header (old browser, curl) the page is treated
 * as a load — the safe side for a first paint.
 */
export async function BootstrapHydrator({ userId, href, children }: { userId: string; href: string; children: ReactNode }) {
  const isRouterFetch = (await headers()).get("sec-fetch-dest") === "empty";
  // Same element either way: a `router.refresh()` must not remount the shell.
  const state = isRouterFetch ? undefined : await buildBootstrapState(userId, href);
  return <HydrationBoundary state={state}>{children}</HydrationBoundary>;
}
