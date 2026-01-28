"use client"

import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query"
import { getFeeds, getArticles, toggleArticleRead, toggleArticleStarred, refreshAllFeeds, importOpml, exportOpml } from "@/app/actions/feeds"

export function useFeeds() {
    return useQuery({
        queryKey: ["feeds"],
        queryFn: () => getFeeds(),
    })
}

export function useArticles(feedId?: string | null) {
    return useQuery({
        queryKey: ["articles", feedId],
        queryFn: () => getArticles(feedId),
    })
}

export function useToggleRead() {
    const queryClient = useQueryClient()
    return useMutation({
        mutationFn: ({ articleId, isRead }: { articleId: string; isRead: boolean }) =>
            toggleArticleRead(articleId, isRead),
        onSuccess: () => {
            queryClient.invalidateQueries({ queryKey: ["articles"] })
            queryClient.invalidateQueries({ queryKey: ["feeds"] })
        },
    })
}

export function useToggleStarred() {
    const queryClient = useQueryClient()
    return useMutation({
        mutationFn: ({ articleId, isStarred }: { articleId: string; isStarred: boolean }) =>
            toggleArticleStarred(articleId, isStarred),
        onSuccess: () => {
            queryClient.invalidateQueries({ queryKey: ["articles"] })
        },
    })
}

export function useRefresh() {
    const queryClient = useQueryClient()
    return useMutation({
        mutationFn: () => refreshAllFeeds(),
        onSuccess: () => {
            queryClient.invalidateQueries({ queryKey: ["feeds"] })
            queryClient.invalidateQueries({ queryKey: ["articles"] })
        },
    })
}

export function useImportOpml() {
    const queryClient = useQueryClient()
    return useMutation({
        mutationFn: (xml: string) => importOpml(xml),
        onSuccess: () => {
            queryClient.invalidateQueries({ queryKey: ["feeds"] })
        },
    })
}

export function useExportOpml() {
    return useMutation({
        mutationFn: () => exportOpml(),
    })
}
