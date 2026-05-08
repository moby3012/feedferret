"use client"

import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query"
import { getFeeds, getArticles, getCategories, toggleArticleRead, toggleArticleStarred, refreshAllFeeds, importOpml, exportOpml, addFeed, deleteFeed, updateFeed, addCategory, updateCategory, deleteCategory, getStarredCount, updateCategoryOrder, updateFeedOrder, markAllAsRead } from "@/app/actions/feeds"
import { updateProfile, updateGlobalSettings } from "@/app/actions/settings"

export function useFeeds() {
    return useQuery({
        queryKey: ["feeds"],
        queryFn: () => getFeeds(),
    })
}

export function useCategories() {
    return useQuery({
        queryKey: ["categories"],
        queryFn: () => getCategories(),
    })
}

export function useStarredCount() {
    return useQuery({
        queryKey: ["articles", "starred-count"],
        queryFn: () => getStarredCount(),
    })
}

export function useArticles(feedId?: string | null, category?: string, search?: string) {
    return useQuery({
        queryKey: ["articles", feedId, category, search],
        queryFn: () => getArticles(feedId, category, search),
        staleTime: 30_000,
    })
}

export function useToggleRead() {
    const queryClient = useQueryClient()
    return useMutation({
        mutationFn: ({ articleId, isRead }: { articleId: string; isRead: boolean }) =>
            toggleArticleRead(articleId, isRead),
        onMutate: async ({ articleId, isRead }) => {
            await queryClient.cancelQueries({ queryKey: ["articles"] })
            const snapshots = queryClient.getQueriesData({ queryKey: ["articles"] })
            const readAt = isRead ? new Date() : null

            snapshots.forEach(([queryKey, old]) => {
                if (!Array.isArray(old)) return
                queryClient.setQueryData(queryKey, old.map((article: any) =>
                    article.id === articleId ? { ...article, isRead, readAt } : article
                ))
            })

            return { snapshots }
        },
        onError: (_error, _variables, context) => {
            context?.snapshots?.forEach(([queryKey, data]) => {
                queryClient.setQueryData(queryKey, data)
            })
        },
        onSuccess: () => {
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
            queryClient.invalidateQueries({ queryKey: ["categories"] })
        },
    })
}

export function useExportOpml() {
    return useMutation({
        mutationFn: () => exportOpml(),
    })
}

export function useAddFeed() {
    const queryClient = useQueryClient()
    return useMutation({
        mutationFn: ({ url, categoryId }: { url: string; categoryId?: string }) => addFeed(url, categoryId),
        onSuccess: () => {
            queryClient.invalidateQueries({ queryKey: ["feeds"] })
        },
    })
}

export function useUpdateFeed() {
    const queryClient = useQueryClient()
    return useMutation({
        mutationFn: ({ feedId, data }: { feedId: string; data: { name?: string; categoryId?: string | null } }) =>
            updateFeed(feedId, data),
        onSuccess: () => {
            queryClient.invalidateQueries({ queryKey: ["feeds"] })
        },
    })
}

export function useDeleteFeed() {
    const queryClient = useQueryClient()
    return useMutation({
        mutationFn: (feedId: string) => deleteFeed(feedId),
        onSuccess: () => {
            queryClient.invalidateQueries({ queryKey: ["feeds"] })
            queryClient.invalidateQueries({ queryKey: ["articles"] })
        },
    })
}

export function useAddCategory() {
    const queryClient = useQueryClient()
    return useMutation({
        mutationFn: ({ name, parentId }: { name: string; parentId?: string }) => addCategory(name, parentId),
        onSuccess: () => {
            queryClient.invalidateQueries({ queryKey: ["feeds"] })
            queryClient.invalidateQueries({ queryKey: ["categories"] })
        },
    })
}

export function useUpdateCategory() {
    const queryClient = useQueryClient()
    return useMutation({
        mutationFn: ({ categoryId, data }: { categoryId: string; data: { name?: string; updateFrequency?: number | null } }) => updateCategory(categoryId, data),
        onSuccess: () => {
            queryClient.invalidateQueries({ queryKey: ["feeds"] })
            queryClient.invalidateQueries({ queryKey: ["categories"] })
        },
    })
}

export function useDeleteCategory() {
    const queryClient = useQueryClient()
    return useMutation({
        mutationFn: (categoryId: string) => deleteCategory(categoryId),
        onSuccess: () => {
            queryClient.invalidateQueries({ queryKey: ["feeds"] })
            queryClient.invalidateQueries({ queryKey: ["categories"] })
        },
    })
}

export function useUpdateCategoryOrder() {
    const queryClient = useQueryClient()
    return useMutation({
        mutationFn: (orders: { id: string; order: number; parentId?: string | null }[]) => updateCategoryOrder(orders),
        onSuccess: () => {
            queryClient.invalidateQueries({ queryKey: ["categories"] })
        },
    })
}

export function useUpdateFeedOrder() {
    const queryClient = useQueryClient()
    return useMutation({
        mutationFn: (orders: { id: string; order: number; categoryId?: string | null }[]) => updateFeedOrder(orders),
        onSuccess: () => {
            queryClient.invalidateQueries({ queryKey: ["feeds"] })
        },
    })
}

export function useUpdateProfile() {
    return useMutation({
        mutationFn: (data: { name?: string; email?: string }) => updateProfile(data),
    })
}

export function useUpdateGlobalSettings() {
    return useMutation({
        mutationFn: (data: { defaultUpdateFrequency?: number }) => updateGlobalSettings(data),
    })
}

export function useMarkAllAsRead() {
    const queryClient = useQueryClient()
    return useMutation({
        mutationFn: (scope?: { feedId?: string | null; category?: string | null }) => markAllAsRead(scope),
        onSuccess: () => {
            queryClient.invalidateQueries({ queryKey: ["articles"] })
            queryClient.invalidateQueries({ queryKey: ["feeds"] })
        },
    })
}
