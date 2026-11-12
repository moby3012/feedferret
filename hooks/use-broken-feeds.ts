"use client"

import { useMemo } from "react"
import { useQuery, type QueryClient } from "@tanstack/react-query"
import { getArchivedFeeds, getBrokenFeeds, getInactiveFeeds } from "@/app/actions/broken-feeds"
import { invalidateCounts } from "@/features/articles/cache"
import { countBrokenFeeds } from "@/lib/broken-feeds"
import { useFeeds } from "@/hooks/use-rss-data"

export const BROKEN_FEEDS_KEY = ["broken-feeds"] as const
export const INACTIVE_FEEDS_KEY = ["inactive-feeds"] as const
export const ARCHIVED_FEEDS_KEY = ["archived-feeds"] as const

/** Archive / restore changes the shell feed list, the counts and all three health lists. */
export function invalidateFeedLists(queryClient: QueryClient) {
    for (const queryKey of [BROKEN_FEEDS_KEY, INACTIVE_FEEDS_KEY, ARCHIVED_FEEDS_KEY, ["feeds"], ["feed-health"]]) {
        void queryClient.invalidateQueries({ queryKey })
    }
    invalidateCounts(queryClient)
}

/** Feeds that fetch fine but published nothing for the user's threshold (default 180 days). */
export function useInactiveFeeds(enabled = true) {
    return useQuery({
        queryKey: INACTIVE_FEEDS_KEY,
        queryFn: () => getInactiveFeeds(),
        enabled,
        staleTime: 0,
        refetchOnWindowFocus: false,
    })
}

/** Archived feeds (Manage Feeds → "Archiviert"). They are not part of the shell feed list. */
export function useArchivedFeeds(enabled = true) {
    return useQuery({
        queryKey: ARCHIVED_FEEDS_KEY,
        queryFn: () => getArchivedFeeds(),
        enabled,
        staleTime: 0,
        refetchOnWindowFocus: false,
    })
}

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
