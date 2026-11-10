"use client";

import { useQuery } from "@tanstack/react-query";
import { shouldRetry } from "@/features/articles/api";
import { briefingKey, fetchBriefing } from "./api";

/** `["briefing", scopeKey]` — cached briefing or headline digest (GET never calls a provider). */
export function useBriefing(scopeKey: string, enabled = true) {
  return useQuery({
    queryKey: briefingKey(scopeKey),
    queryFn: ({ signal }) => fetchBriefing(scopeKey, signal),
    enabled,
    staleTime: 60_000,
    refetchOnWindowFocus: false,
    retry: shouldRetry,
  });
}
