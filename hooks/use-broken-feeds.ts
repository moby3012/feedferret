"use client"

import { useMemo } from "react"
import { useQuery } from "@tanstack/react-query"
import { getBrokenFeeds } from "@/app/actions/broken-feeds"
import { countBrokenFeeds } from "@/lib/broken-feeds"
import { useFeeds } from "@/hooks/use-rss-data"

export const BROKEN_FEEDS_KEY = ["broken-feeds"] as const

/** The triage list (server-categorised, redacted). Always refetched on mount: it reflects live sync state. */
export function useBrokenFeeds(enabled = true) {
    return useQuery({
        queryKey: BROKEN_FEEDS_KEY,
        queryFn: () => getBrokenFeeds(),
        enabled,
        staleTime: 0,
        refetchOnWindowFocus: false,
    })
}

/** N of "Defekte Feeds (N)": derived from the feed list the shell already holds (no extra request). */
export function useBrokenFeedCount(): number {
    const { data: feeds } = useFeeds()
    return useMemo(() => countBrokenFeeds((feeds as any[] | undefined) ?? []), [feeds])
}
