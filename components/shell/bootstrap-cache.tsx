"use client";

import { useMemo, type ReactNode } from "react";
import { useQueryClient, type DehydratedState } from "@tanstack/react-query";
import { hydrateMissing } from "@/features/bootstrap/hydrate-missing";

/**
 * Client half of the cold-start bootstrap: puts the server snapshot into the
 * cache during render (before the shell's queries read it, like
 * `<HydrationBoundary>` does for new queries), but never over an entry the
 * client already has — see `hydrateMissing`.
 */
export function BootstrapCache({ state, children }: { state: DehydratedState | undefined; children: ReactNode }) {
  const qc = useQueryClient();
  // Render-time write of keys no observer reads yet (idempotent: a second run finds them present).
  useMemo(() => hydrateMissing(qc, state), [qc, state]);
  return children;
}
