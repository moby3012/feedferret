"use client"

import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query"
import { getFeeds, getArticles, getCategories, toggleArticleRead, toggleArticleStarred, refreshAllFeeds, importOpml, exportOpml, addFeed, deleteFeed, updateFeed, addCategory, updateCategory, deleteCategory, getStarredCount, updateCategoryOrder, updateFeedOrder, markAllAsRead, fetchFullText, getLabels, createLabel, updateLabel, deleteLabel, setArticleLabels, getSavedSearches, createSavedSearch, updateSavedSearch, deleteSavedSearch, getFeedHealth, applyRetentionPolicies } from "@/app/actions/feeds"
import { updateProfile, updateGlobalSettings } from "@/app/actions/settings"
import { toast } from "sonner"

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

export function useLabels() {
    return useQuery({
        queryKey: ["labels"],
        queryFn: () => getLabels(),
    })
}

export function useSavedSearches() {
    return useQuery({
        queryKey: ["saved-searches"],
        queryFn: () => getSavedSearches(),
    })
}

export function useFeedHealth() {
    return useQuery({
        queryKey: ["feed-health"],
        queryFn: () => getFeedHealth(),
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
        mutationFn: ({ feedId, data }: { feedId: string; data: { name?: string; categoryId?: string | null; updateFrequency?: number | null; retentionDays?: number | null } }) =>
            updateFeed(feedId, data),
        onSuccess: () => {
            queryClient.invalidateQueries({ queryKey: ["feeds"] })
        },
    })
}

export function useApplyRetentionPolicies() {
    const queryClient = useQueryClient()
    return useMutation({
        mutationFn: () => applyRetentionPolicies(),
        onSuccess: (result) => {
            queryClient.invalidateQueries({ queryKey: ["articles"] })
            queryClient.invalidateQueries({ queryKey: ["feeds"] })
            queryClient.invalidateQueries({ queryKey: ["feed-health"] })
            toast.success(`Retention applied: ${result.deleted} articles removed`)
        },
        onError: (error) => {
            toast.error(error instanceof Error ? error.message : "Retention failed")
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

export function useFetchFullText() {
    const queryClient = useQueryClient()
    return useMutation({
        mutationFn: (articleId: string) => fetchFullText(articleId),
        onSuccess: (article: any) => {
            queryClient.setQueriesData({ queryKey: ["articles"] }, (old: any) => {
                if (!Array.isArray(old)) return old
                return old.map((item) => item.id === article.id ? article : item)
            })
            toast.success("Full text loaded")
        },
        onError: (error) => {
            toast.error(error instanceof Error ? error.message : "Could not fetch full text")
        },
    })
}

export function useCreateLabel() {
    const queryClient = useQueryClient()
    return useMutation({
        mutationFn: (data: { name: string; color?: string }) => createLabel(data),
        onSuccess: () => {
            queryClient.invalidateQueries({ queryKey: ["labels"] })
        },
    })
}

export function useUpdateLabel() {
    const queryClient = useQueryClient()
    return useMutation({
        mutationFn: ({ labelId, data }: { labelId: string; data: { name?: string; color?: string } }) => updateLabel(labelId, data),
        onSuccess: () => {
            queryClient.invalidateQueries({ queryKey: ["labels"] })
            queryClient.invalidateQueries({ queryKey: ["articles"] })
        },
    })
}

export function useDeleteLabel() {
    const queryClient = useQueryClient()
    return useMutation({
        mutationFn: (labelId: string) => deleteLabel(labelId),
        onSuccess: () => {
            queryClient.invalidateQueries({ queryKey: ["labels"] })
            queryClient.invalidateQueries({ queryKey: ["articles"] })
        },
    })
}

export function useSetArticleLabels() {
    const queryClient = useQueryClient()
    return useMutation({
        mutationFn: ({ articleId, labelIds }: { articleId: string; labelIds: string[] }) => setArticleLabels(articleId, labelIds),
        onSuccess: (article: any) => {
            queryClient.invalidateQueries({ queryKey: ["labels"] })
            queryClient.setQueriesData({ queryKey: ["articles"] }, (old: any) => {
                if (!Array.isArray(old) || !article) return old
                return old.map((item) => item.id === article.id ? article : item)
            })
        },
    })
}

export function useCreateSavedSearch() {
    const queryClient = useQueryClient()
    return useMutation({
        mutationFn: (data: { name: string; query: string }) => createSavedSearch(data),
        onSuccess: () => {
            queryClient.invalidateQueries({ queryKey: ["saved-searches"] })
            toast.success("Search saved")
        },
        onError: (error) => {
            toast.error(error instanceof Error ? error.message : "Could not save search")
        },
    })
}

export function useUpdateSavedSearch() {
    const queryClient = useQueryClient()
    return useMutation({
        mutationFn: ({ searchId, data }: { searchId: string; data: { name?: string; query?: string; order?: number } }) => updateSavedSearch(searchId, data),
        onSuccess: () => {
            queryClient.invalidateQueries({ queryKey: ["saved-searches"] })
        },
    })
}

export function useDeleteSavedSearch() {
    const queryClient = useQueryClient()
    return useMutation({
        mutationFn: (searchId: string) => deleteSavedSearch(searchId),
        onSuccess: () => {
            queryClient.invalidateQueries({ queryKey: ["saved-searches"] })
        },
    })
}
