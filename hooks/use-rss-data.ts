"use client"

import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query"
import { useTranslations } from "next-intl"
import { getFeeds, getArticles, getCategories, toggleArticleRead, toggleArticleStarred, toggleArticleReadLater, refreshAllFeeds, refreshFeed, importOpml, exportOpml, exportUserData, addFeed, deleteFeed, updateFeed, addCategory, updateCategory, deleteCategory, getStarredCount, getReadLaterCount, getSpoilerCount, updateCategoryOrder, updateFeedOrder, markAllAsRead, markArticlesAsUnread, fetchFullText, getLabels, createLabel, updateLabel, deleteLabel, setArticleLabels, getSavedSearches, createSavedSearch, updateSavedSearch, deleteSavedSearch, setSavedSearchSharing, getFeedHealth, applyRetentionPolicies, getAutoReadRules, createAutoReadRule, updateAutoReadRule, deleteAutoReadRule, applyAutoReadRulesNow, previewAutoReadRule, migrateKeywordAlertsToRules, getKeywordAlerts, createKeywordAlert, updateKeywordAlert, deleteKeywordAlert, previewKeywordAlertMatches, testKeywordAlert, getNotifications, getUnreadNotificationCount, markNotificationRead, markAllNotificationsRead, previewFeedExtraction, summarizeArticle, releaseArticleSpoiler, releaseAllSpoilers, suggestFeedFromUrl, createFeedFromPage, proposeAiFeedConfig, proposeAiFullTextSelector } from "@/app/actions/feeds"
import { updateProfile, changePassword, updateGlobalSettings, getReadingPreferences, getDigestSettings, updateDigestSettings, sendTestDigest, previewDigest, getTwoFactorStatus, beginTwoFactorSetup, confirmTwoFactorSetup, disableTwoFactor, getAiSettings, updateAiSettings, testAiConnection, getContentFetchSettings, updateContentFetchSettings, testContentFetchConnection, getNotificationChannels, updateNotificationChannels, testNotificationChannel, getNotificationChannelStatus } from "@/app/actions/settings"
import { updateUiLanguage } from "@/app/actions/locale"
import { toast } from "sonner"

export function useFeeds(enabled = true) {
    return useQuery({
        queryKey: ["feeds"],
        queryFn: () => getFeeds(),
        enabled,
        // Keep sidebar unread badges live: refetch in background every 60s
        // and whenever the tab regains focus (React Query default).
        refetchInterval: 60_000,
        refetchIntervalInBackground: false,
        staleTime: 15_000,
    })
}

export function useCategories(enabled = true) {
    return useQuery({
        queryKey: ["categories"],
        queryFn: () => getCategories(),
        enabled,
    })
}

export function useStarredCount() {
    return useQuery({
        queryKey: ["articles", "starred-count"],
        queryFn: () => getStarredCount(),
    })
}

export function useReadLaterCount() {
    return useQuery({
        queryKey: ["articles", "read-later-count"],
        queryFn: () => getReadLaterCount(),
    })
}

export function useSpoilerCount() {
    return useQuery({
        queryKey: ["articles", "spoiler-count"],
        queryFn: () => getSpoilerCount(),
    })
}

export function useLabels(enabled = true) {
    return useQuery({
        queryKey: ["labels"],
        queryFn: () => getLabels(),
        enabled,
        refetchInterval: 60_000,
        refetchIntervalInBackground: false,
        staleTime: 15_000,
    })
}

export function useSavedSearches(enabled = true) {
    return useQuery({
        queryKey: ["saved-searches"],
        queryFn: () => getSavedSearches(),
        enabled,
    })
}

export function useFeedHealth() {
    return useQuery({
        queryKey: ["feed-health"],
        queryFn: () => getFeedHealth(),
    })
}

export function useArticles(feedId?: string | null, category?: string, search?: string, enabled = true) {
    return useQuery({
        queryKey: ["articles", feedId, category, search],
        queryFn: () => getArticles(feedId, category, search),
        staleTime: 30_000,
        enabled,
    })
}

export function useToggleRead() {
    const queryClient = useQueryClient()
    return useMutation({
        mutationFn: ({ articleId, isRead }: { articleId: string; isRead: boolean }) =>
            toggleArticleRead(articleId, isRead),
        onMutate: async ({ articleId, isRead }) => {
            await queryClient.cancelQueries({ queryKey: ["articles"] })
            await queryClient.cancelQueries({ queryKey: ["feeds"] })
            const snapshots = queryClient.getQueriesData({ queryKey: ["articles"] })
            const feedsSnapshot = queryClient.getQueryData<any[]>(["feeds"])
            const readAt = isRead ? new Date() : null

            // Find the article in any cached list to know its feed and labels
            let affectedFeedId: string | undefined
            let articleLabelIds: string[] = []
            for (const [, old] of snapshots) {
                if (!Array.isArray(old)) continue
                const hit = old.find((a: any) => a.id === articleId)
                if (hit) {
                    affectedFeedId = hit.feedId ?? hit.feed?.id
                    articleLabelIds = (hit.labels ?? []).map((l: any) => l.labelId ?? l.label?.id).filter(Boolean)
                    break
                }
            }

            snapshots.forEach(([queryKey, old]) => {
                if (!Array.isArray(old)) return
                queryClient.setQueryData(queryKey, old.map((article: any) =>
                    article.id === articleId ? { ...article, isRead, readAt } : article
                ))
            })

            // Optimistically adjust the feed's unread count so sidebar badge updates immediately (#19)
            if (affectedFeedId && Array.isArray(feedsSnapshot)) {
                queryClient.setQueryData(["feeds"], feedsSnapshot.map((f: any) => {
                    if (f.id !== affectedFeedId) return f
                    const current = f._count?.articles ?? 0
                    const delta = isRead ? -1 : 1
                    const next = Math.max(0, current + delta)
                    return { ...f, _count: { ...(f._count || {}), articles: next } }
                }))
            }

            // Optimistically adjust label unread counts
            const labelsSnapshot = queryClient.getQueryData<any[]>(["labels"])
            if (articleLabelIds.length > 0 && Array.isArray(labelsSnapshot)) {
                const delta = isRead ? -1 : 1
                queryClient.setQueryData(["labels"], labelsSnapshot.map((l: any) =>
                    articleLabelIds.includes(l.id)
                        ? { ...l, _count: { ...l._count, articles: Math.max(0, (l._count?.articles ?? 0) + delta) } }
                        : l
                ))
            }

            return { snapshots, feedsSnapshot, labelsSnapshot }
        },
        onError: (_error, _variables, context) => {
            context?.snapshots?.forEach(([queryKey, data]) => {
                queryClient.setQueryData(queryKey, data)
            })
            if (context?.feedsSnapshot) {
                queryClient.setQueryData(["feeds"], context.feedsSnapshot)
            }
            if (context?.labelsSnapshot) {
                queryClient.setQueryData(["labels"], context.labelsSnapshot)
            }
        },
        onSuccess: () => {
            queryClient.invalidateQueries({ queryKey: ["feeds"] })
            queryClient.invalidateQueries({ queryKey: ["labels"] })
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

export function useToggleReadLater() {
    const queryClient = useQueryClient()
    return useMutation({
        mutationFn: ({ articleId, isReadLater }: { articleId: string; isReadLater: boolean }) =>
            toggleArticleReadLater(articleId, isReadLater),
        onSuccess: () => {
            queryClient.invalidateQueries({ queryKey: ["articles"] })
            queryClient.invalidateQueries({ queryKey: ["articles", "read-later-count"] })
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

export function useRefreshFeed() {
    const queryClient = useQueryClient()
    return useMutation({
        mutationFn: (feedId: string) => refreshFeed(feedId),
        onSuccess: () => {
            queryClient.invalidateQueries({ queryKey: ["feeds"] })
            queryClient.invalidateQueries({ queryKey: ["articles"] })
            queryClient.invalidateQueries({ queryKey: ["feed-health"] })
            toast.success("Feed refreshed")
        },
        onError: (error) => {
            toast.error(error instanceof Error ? error.message : "Feed sync failed. Check your connection and try again.")
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
        mutationFn: (selectedFeedIds?: string[]) => exportOpml(selectedFeedIds),
    })
}

export function useExportUserData() {
    return useMutation({
        mutationFn: () => exportUserData(),
        onError: (error) => {
            toast.error(error instanceof Error ? error.message : "Export failed. Try again or contact support.")
        },
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

export function useSuggestFeedFromUrl() {
    return useMutation({
        mutationFn: (url: string) => suggestFeedFromUrl(url),
    })
}

export function useProposeAiFeedConfig() {
    return useMutation({
        mutationFn: (url: string) => proposeAiFeedConfig(url),
    })
}

export function useProposeAiFullTextSelector() {
    return useMutation({
        mutationFn: (feedId: string) => proposeAiFullTextSelector(feedId),
    })
}

export function useCreateFeedFromPage() {
    const queryClient = useQueryClient()
    return useMutation({
        mutationFn: (input: Parameters<typeof createFeedFromPage>[0]) => createFeedFromPage(input),
        onSuccess: () => {
            queryClient.invalidateQueries({ queryKey: ["feeds"] })
        },
    })
}

export function useUpdateFeed() {
    const queryClient = useQueryClient()
    return useMutation({
        mutationFn: ({ feedId, data }: { feedId: string; data: Parameters<typeof updateFeed>[1] }) =>
            updateFeed(feedId, data),
        onSuccess: () => {
            queryClient.invalidateQueries({ queryKey: ["feeds"] })
        },
    })
}

export function useApplyRetentionPolicies() {
    const queryClient = useQueryClient()
    return useMutation({
        mutationFn: (dryRun: boolean) => applyRetentionPolicies(dryRun),
        onSuccess: (result) => {
            if (result.dryRun) {
                toast.info(`Dry run: ${result.deleted} articles would be removed`)
            } else {
                queryClient.invalidateQueries({ queryKey: ["articles"] })
                queryClient.invalidateQueries({ queryKey: ["feeds"] })
                queryClient.invalidateQueries({ queryKey: ["feed-health"] })
                toast.success(`Retention applied: ${result.deleted} articles removed`)
            }
        },
        onError: (error) => {
            toast.error(error instanceof Error ? error.message : "Retention policy failed. Try again.")
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

export function useReadingPreferences(enabled = true) {
    return useQuery({
        queryKey: ["reading-preferences"],
        queryFn: () => getReadingPreferences(),
        enabled,
    })
}

export function useUpdateProfile() {
    return useMutation({
        mutationFn: (data: { name?: string; email?: string }) => updateProfile(data),
    })
}

export function useChangePassword() {
    return useMutation({
        mutationFn: (data: Parameters<typeof changePassword>[0]) => changePassword(data),
    })
}

export function useUpdateGlobalSettings() {
    const queryClient = useQueryClient()
    return useMutation({
        mutationFn: (data: Parameters<typeof updateGlobalSettings>[0]) =>
            updateGlobalSettings(data),
        onMutate: async (data) => {
            await queryClient.cancelQueries({ queryKey: ["reading-preferences"] })
            const prev = queryClient.getQueryData(["reading-preferences"])
            queryClient.setQueryData(["reading-preferences"], (old: any) =>
                old ? { ...old, ...data } : old,
            )
            return { prev }
        },
        onError: (_err, _vars, context) => {
            if (context?.prev !== undefined) {
                queryClient.setQueryData(["reading-preferences"], context.prev)
            }
        },
        onSuccess: () => {
            queryClient.invalidateQueries({ queryKey: ["reading-preferences"] })
        },
    })
}

export function useUpdateUiLanguage() {
    const queryClient = useQueryClient()
    return useMutation({
        mutationFn: (locale: string) => updateUiLanguage(locale),
        onMutate: async (locale) => {
            await queryClient.cancelQueries({ queryKey: ["reading-preferences"] })
            const prev = queryClient.getQueryData(["reading-preferences"])
            queryClient.setQueryData(["reading-preferences"], (old: any) =>
                old ? { ...old, uiLanguage: locale } : old,
            )
            return { prev }
        },
        onError: (_err, _vars, context) => {
            if (context?.prev !== undefined) {
                queryClient.setQueryData(["reading-preferences"], context.prev)
            }
        },
    })
}

export function useMarkAllAsRead() {
    const queryClient = useQueryClient()
    return useMutation({
        mutationFn: (scope?: { feedId?: string | null; category?: string | null }) => markAllAsRead(scope),
        onMutate: async (scope) => {
            await queryClient.cancelQueries({ queryKey: ["feeds"] })
            const feedsSnapshot = queryClient.getQueryData<any[]>(["feeds"])
            if (Array.isArray(feedsSnapshot)) {
                // Optimistic: zero unread on the affected feed(s) so badge updates instantly (#19)
                const next = feedsSnapshot.map((f: any) => {
                    if (scope?.feedId) {
                        if (f.id !== scope.feedId) return f
                        return { ...f, _count: { ...(f._count || {}), articles: 0 } }
                    }
                    if (!scope?.feedId && !scope?.category) {
                        return { ...f, _count: { ...(f._count || {}), articles: 0 } }
                    }
                    // Category-scoped: cannot reliably know which feeds belong without the
                    // category map here, so fall back to invalidation in onSuccess.
                    return f
                })
                queryClient.setQueryData(["feeds"], next)
            }

            // Optimistic: zero the label badge immediately when marking a label scope as read
            let labelsSnapshot: any[] | undefined
            if (scope?.category?.startsWith("Label:")) {
                const labelId = scope.category.slice("Label:".length)
                labelsSnapshot = queryClient.getQueryData<any[]>(["labels"])
                if (Array.isArray(labelsSnapshot)) {
                    queryClient.setQueryData(["labels"], labelsSnapshot.map((l: any) =>
                        l.id === labelId ? { ...l, _count: { ...l._count, articles: 0 } } : l
                    ))
                }
            }

            return { feedsSnapshot, labelsSnapshot }
        },
        onError: (_error, _variables, context) => {
            if (context?.feedsSnapshot) {
                queryClient.setQueryData(["feeds"], context.feedsSnapshot)
            }
            if (context?.labelsSnapshot) {
                queryClient.setQueryData(["labels"], context.labelsSnapshot)
            }
        },
        onSuccess: () => {
            queryClient.invalidateQueries({ queryKey: ["articles"] })
            queryClient.invalidateQueries({ queryKey: ["feeds"] })
            queryClient.invalidateQueries({ queryKey: ["labels"] })
        },
    })
}

// Powers the "Undo" action on the auto-mark-all-read toast shown when
// swiping to the next feed (see app/page.tsx navigateFeed).
export function useMarkArticlesAsUnread() {
    const queryClient = useQueryClient()
    return useMutation({
        mutationFn: (articleIds: string[]) => markArticlesAsUnread(articleIds),
        onSuccess: () => {
            queryClient.invalidateQueries({ queryKey: ["articles"] })
            queryClient.invalidateQueries({ queryKey: ["feeds"] })
            queryClient.invalidateQueries({ queryKey: ["labels"] })
        },
        onError: () => {
            toast.error("Could not undo mark-as-read. Try refreshing the page.")
        },
    })
}

export function useFetchFullText() {
    const queryClient = useQueryClient()
    const updateFeedMutation = useUpdateFeed()
    const t = useTranslations("articleReader")
    return useMutation({
        mutationFn: (articleId: string) => fetchFullText(articleId),
        onSuccess: (article: any) => {
            queryClient.setQueriesData({ queryKey: ["articles"] }, (old: any) => {
                if (!Array.isArray(old)) return old
                return old.map((item) => item.id === article.id ? article : item)
            })
            toast.success(t("fullTextLoaded"))

            const suggestion = article.suggestAutoFullText
            if (suggestion) {
                toast(t("truncatedFeedSuggestion"), {
                    description: suggestion.feedName,
                    action: {
                        label: t("enableAutoFullText"),
                        onClick: () => updateFeedMutation.mutate({ feedId: suggestion.feedId, data: { fullTextMode: "auto" } }),
                    },
                    cancel: {
                        label: t("dontAskAgainFullText"),
                        onClick: () => updateFeedMutation.mutate({ feedId: suggestion.feedId, data: { fullTextAutoSuggestDismissed: true } }),
                    },
                    duration: 10000,
                })
            }
        },
        onError: (error) => {
            toast.error(error instanceof Error ? error.message : t("fullTextUnavailable"))
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

export function useAutoReadRules() {
    return useQuery({
        queryKey: ["auto-read-rules"],
        queryFn: () => getAutoReadRules(),
    })
}

export function useCreateAutoReadRule() {
    const queryClient = useQueryClient()
    return useMutation({
        mutationFn: (data: {
            name: string;
            query: string;
            action?: string;
            actions?: string[];
            scope?: string | null;
            trigger?: string;
            webhookConfigs?: unknown;
            removeSpoilerOnDelete?: boolean;
        }) => createAutoReadRule(data),
        onSuccess: () => {
            queryClient.invalidateQueries({ queryKey: ["auto-read-rules"] })
            toast.success("Rule created")
        },
        onError: (error) => {
            toast.error(error instanceof Error ? error.message : "Could not create rule. Check the filter and try again.")
        },
    })
}

export function useUpdateAutoReadRule() {
    const queryClient = useQueryClient()
    return useMutation({
        mutationFn: ({
            ruleId,
            data,
        }: {
            ruleId: string
            data: Partial<{
                name: string;
                query: string;
                action: string;
                actions: string[];
                scope: string | null;
                enabled: boolean;
                order: number;
                trigger: string;
                webhookConfigs: unknown;
                removeSpoilerOnDelete: boolean;
            }>
        }) => updateAutoReadRule(ruleId, data),
        onSuccess: () => {
            queryClient.invalidateQueries({ queryKey: ["auto-read-rules"] })
        },
        onError: (error) => {
            toast.error(error instanceof Error ? error.message : "Rule update failed. Try saving again.")
        },
    })
}

export function useDeleteAutoReadRule() {
    const queryClient = useQueryClient()
    return useMutation({
        mutationFn: (ruleId: string) => deleteAutoReadRule(ruleId),
        onSuccess: () => {
            queryClient.invalidateQueries({ queryKey: ["auto-read-rules"] })
            queryClient.invalidateQueries({ queryKey: ["articles"] })
            queryClient.invalidateQueries({ queryKey: ["articles", "spoiler-count"] })
            toast.success("Rule deleted")
        },
    })
}

export function useReleaseArticleSpoiler() {
    const queryClient = useQueryClient()
    return useMutation({
        mutationFn: (articleId: string) => releaseArticleSpoiler(articleId),
        onMutate: async (articleId) => {
            await queryClient.cancelQueries({ queryKey: ["articles"] })
            const snapshots = queryClient.getQueriesData({ queryKey: ["articles"] })
            snapshots.forEach(([queryKey, old]) => {
                if (!Array.isArray(old)) return
                queryClient.setQueryData(queryKey, old.filter((a: any) => a.id !== articleId))
            })
            const prev = queryClient.getQueryData<number>(["articles", "spoiler-count"])
            if (typeof prev === "number") {
                queryClient.setQueryData(["articles", "spoiler-count"], Math.max(0, prev - 1))
            }
            return { snapshots, prev }
        },
        onError: (_err, _id, ctx) => {
            ctx?.snapshots?.forEach(([queryKey, data]) => queryClient.setQueryData(queryKey, data))
            if (ctx?.prev !== undefined) queryClient.setQueryData(["articles", "spoiler-count"], ctx.prev)
        },
        onSettled: () => {
            queryClient.invalidateQueries({ queryKey: ["articles"] })
            queryClient.invalidateQueries({ queryKey: ["articles", "spoiler-count"] })
        },
    })
}

export function useReleaseAllSpoilers() {
    const queryClient = useQueryClient()
    return useMutation({
        mutationFn: () => releaseAllSpoilers(),
        onSuccess: () => {
            queryClient.invalidateQueries({ queryKey: ["articles"] })
            queryClient.invalidateQueries({ queryKey: ["articles", "spoiler-count"] })
            toast.success("All spoiler flags released")
        },
        onError: () => {
            toast.error("Could not remove spoiler flag. Try refreshing the page.")
        },
    })
}

export function useApplyAutoReadRulesNow() {
    const queryClient = useQueryClient()
    return useMutation({
        mutationFn: () => applyAutoReadRulesNow(),
        onSuccess: (result) => {
            queryClient.invalidateQueries({ queryKey: ["articles"] })
            queryClient.invalidateQueries({ queryKey: ["feeds"] })
            toast.success(`Rules applied: ${result.applied} articles updated`)
        },
        onError: (error) => {
            toast.error(error instanceof Error ? error.message : "Rules could not be applied. Try again.")
        },
    })
}

export function usePreviewAutoReadRule() {
    return useMutation({
        mutationFn: ({ query, scope, limit }: { query: string; scope?: string | null; limit?: number }) =>
            previewAutoReadRule(query, scope ?? null, limit),
    })
}

export function useMigrateKeywordAlertsToRules() {
    const queryClient = useQueryClient()
    return useMutation({
        mutationFn: () => migrateKeywordAlertsToRules(),
        onSuccess: (result) => {
            queryClient.invalidateQueries({ queryKey: ["auto-read-rules"] })
            queryClient.invalidateQueries({ queryKey: ["keyword-alerts"] })
            toast.success(`Migrated ${result.migrated} alert${result.migrated === 1 ? "" : "s"} to rules`)
        },
        onError: (error) => {
            toast.error(error instanceof Error ? error.message : "Migration failed. No data was changed.")
        },
    })
}


export function useKeywordAlerts() {
    return useQuery({
        queryKey: ["keyword-alerts"],
        queryFn: () => getKeywordAlerts(),
    })
}

export function useCreateKeywordAlert() {
    const queryClient = useQueryClient()
    return useMutation({
        mutationFn: (data: { name: string; query: string; scope?: string; actions?: string[] }) =>
            createKeywordAlert(data),
        onSuccess: () => {
            queryClient.invalidateQueries({ queryKey: ["keyword-alerts"] })
            toast.success("Alert created")
        },
        onError: (error) => {
            toast.error(error instanceof Error ? error.message : "Could not create alert. Check the keyword and try again.")
        },
    })
}

export function useUpdateKeywordAlert() {
    const queryClient = useQueryClient()
    return useMutation({
        mutationFn: ({
            alertId,
            data,
        }: {
            alertId: string
            data: Partial<{ name: string; query: string; scope: string; actions: string[]; enabled: boolean }>
        }) => updateKeywordAlert(alertId, data),
        onSuccess: () => {
            queryClient.invalidateQueries({ queryKey: ["keyword-alerts"] })
        },
        onError: (error) => {
            toast.error(error instanceof Error ? error.message : "Alert update failed. Try saving again.")
        },
    })
}

export function useDeleteKeywordAlert() {
    const queryClient = useQueryClient()
    return useMutation({
        mutationFn: (alertId: string) => deleteKeywordAlert(alertId),
        onSuccess: () => {
            queryClient.invalidateQueries({ queryKey: ["keyword-alerts"] })
            toast.success("Alert deleted")
        },
    })
}

export function usePreviewKeywordAlert() {
    return useMutation({
        mutationFn: ({ query, scope, limit }: { query: string; scope?: string; limit?: number }) =>
            previewKeywordAlertMatches(query, scope, limit),
    })
}

export function useTestKeywordAlert() {
    return useMutation({
        mutationFn: (alertId: string) => testKeywordAlert(alertId),
        onSuccess: (matches) => {
            toast.info(`Alert matches ${matches.length} recent article${matches.length !== 1 ? "s" : ""}`)
        },
    })
}

export function useNotifications() {
    return useQuery({
        queryKey: ["notifications"],
        queryFn: () => getNotifications(),
        refetchInterval: 60_000,
    })
}

export function useUnreadNotificationCount() {
    return useQuery({
        queryKey: ["notifications", "unread-count"],
        queryFn: () => getUnreadNotificationCount(),
        refetchInterval: 60_000,
    })
}

export function useMarkNotificationRead() {
    const queryClient = useQueryClient()
    return useMutation({
        mutationFn: (notificationId: string) => markNotificationRead(notificationId),
        onSuccess: () => {
            queryClient.invalidateQueries({ queryKey: ["notifications"] })
        },
    })
}

export function useMarkAllNotificationsRead() {
    const queryClient = useQueryClient()
    return useMutation({
        mutationFn: () => markAllNotificationsRead(),
        onSuccess: () => {
            queryClient.invalidateQueries({ queryKey: ["notifications"] })
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
            toast.error(error instanceof Error ? error.message : "Could not save search. Try a different name.")
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

export function useSetSavedSearchSharing() {
    const queryClient = useQueryClient()
    return useMutation({
        mutationFn: ({ searchId, enabled }: { searchId: string; enabled: boolean }) =>
            setSavedSearchSharing(searchId, enabled),
        onSuccess: (_result, variables) => {
            queryClient.invalidateQueries({ queryKey: ["saved-searches"] })
            toast.success(variables.enabled ? "Search sharing enabled" : "Search sharing disabled")
        },
        onError: (error) => {
            toast.error(error instanceof Error ? error.message : "Sharing settings could not be updated. Try again.")
        },
    })
}

export function usePreviewFeedExtraction() {
    return useMutation({
        mutationFn: ({ feedId, articleUrl }: { feedId: string; articleUrl: string }) =>
            previewFeedExtraction(feedId, articleUrl),
    })
}

export function useDigestSettings() {
    return useQuery({
        queryKey: ["digest-settings"],
        queryFn: () => getDigestSettings(),
    })
}

export function useUpdateDigestSettings() {
    const queryClient = useQueryClient()
    return useMutation({
        mutationFn: (data: Parameters<typeof updateDigestSettings>[0]) => updateDigestSettings(data),
        onSuccess: () => {
            queryClient.invalidateQueries({ queryKey: ["digest-settings"] })
        },
        onError: (error) => {
            toast.error(error instanceof Error ? error.message : "Digest settings could not be saved. Try again.")
        },
    })
}

export function useSendTestDigest() {
    return useMutation({
        mutationFn: () => sendTestDigest(),
        onSuccess: (result) => {
            toast.success(`Test digest sent — ${result.articleCount} article${result.articleCount !== 1 ? "s" : ""}`)
        },
        onError: (error) => {
            toast.error(error instanceof Error ? error.message : "Test digest could not be sent. Check your email settings.")
        },
    })
}

export function usePreviewDigest() {
    return useMutation({
        mutationFn: () => previewDigest(),
    })
}


export function useTwoFactorStatus() {
    return useQuery({
        queryKey: ["two-factor-status"],
        queryFn: () => getTwoFactorStatus(),
    })
}

export function useBeginTwoFactorSetup() {
    const queryClient = useQueryClient()
    return useMutation({
        mutationFn: () => beginTwoFactorSetup(),
        onSuccess: () => {
            queryClient.invalidateQueries({ queryKey: ["two-factor-status"] })
        },
        onError: (error) => {
            toast.error(error instanceof Error ? error.message : "Could not start 2FA setup. Make sure your account has an email address.")
        },
    })
}

export function useConfirmTwoFactorSetup() {
    const queryClient = useQueryClient()
    return useMutation({
        mutationFn: (code: string) => confirmTwoFactorSetup(code),
        onSuccess: () => {
            queryClient.invalidateQueries({ queryKey: ["two-factor-status"] })
            toast.success("Two-factor authentication enabled")
        },
        onError: (error) => {
            toast.error(error instanceof Error ? error.message : "Could not enable 2FA. Check the code and try again.")
        },
    })
}

export function useDisableTwoFactor() {
    const queryClient = useQueryClient()
    return useMutation({
        mutationFn: (code: string) => disableTwoFactor(code),
        onSuccess: () => {
            queryClient.invalidateQueries({ queryKey: ["two-factor-status"] })
            toast.success("Two-factor authentication disabled")
        },
        onError: (error) => {
            toast.error(error instanceof Error ? error.message : "Could not disable 2FA. Check the code and try again.")
        },
    })
}

// Outbound webhooks are now inline rule actions configured under
// /manage-feeds → Rules & Alerts. The legacy Webhook + WebhookDelivery
// models, server actions, and hooks have been removed.

export function useAlertHistory(alertId: string | null) {
    return useQuery({
        queryKey: ["alert-history", alertId],
        queryFn: () => import("@/app/actions/feeds").then(m => m.getAlertHistory(alertId!, 20)),
        enabled: !!alertId,
        staleTime: 10_000,
    })
}

export function useAiSettings() {
    return useQuery({
        queryKey: ["ai-settings"],
        queryFn: () => getAiSettings(),
    })
}

export function useUpdateAiSettings() {
    const queryClient = useQueryClient()
    return useMutation({
        mutationFn: (data: Parameters<typeof updateAiSettings>[0]) => updateAiSettings(data),
        onSuccess: () => {
            queryClient.invalidateQueries({ queryKey: ["ai-settings"] })
            toast.success("AI settings saved")
        },
        onError: (err) => {
            toast.error(err instanceof Error ? err.message : "AI settings could not be saved. Try again.")
        },
    })
}

export function useTestAiConnection() {
    return useMutation({
        mutationFn: (overrides?: Parameters<typeof testAiConnection>[0]) => testAiConnection(overrides),
    })
}

export function useContentFetchSettings() {
    return useQuery({
        queryKey: ["content-fetch-settings"],
        queryFn: () => getContentFetchSettings(),
    })
}

export function useUpdateContentFetchSettings() {
    const queryClient = useQueryClient()
    return useMutation({
        mutationFn: (data: Parameters<typeof updateContentFetchSettings>[0]) => updateContentFetchSettings(data),
        onSuccess: () => {
            queryClient.invalidateQueries({ queryKey: ["content-fetch-settings"] })
            toast.success("Content-fetch settings saved")
        },
        onError: (err) => {
            toast.error(err instanceof Error ? err.message : "Content-fetch settings could not be saved. Try again.")
        },
    })
}

export function useTestContentFetchConnection() {
    return useMutation({
        mutationFn: (overrides?: Parameters<typeof testContentFetchConnection>[0]) => testContentFetchConnection(overrides),
    })
}

export function useSummarizeArticle() {
    const queryClient = useQueryClient()
    const t = useTranslations("articleReader")
    return useMutation({
        mutationFn: (articleId: string) => summarizeArticle(articleId),
        onSuccess: () => {
            queryClient.invalidateQueries({ queryKey: ["articles"] })
        },
        onError: (err) => {
            toast.error(err instanceof Error ? err.message : t("summarizeFailed"))
        },
    })
}

export function useNotificationChannels() {
    return useQuery({
        queryKey: ["notification-channels"],
        queryFn: () => getNotificationChannels(),
    })
}

export function useNotificationChannelStatus() {
    return useQuery({
        queryKey: ["notification-channel-status"],
        queryFn: () => getNotificationChannelStatus(),
        staleTime: 60_000,
    })
}

export function useUpdateNotificationChannels() {
    const queryClient = useQueryClient()
    return useMutation({
        mutationFn: (data: Parameters<typeof updateNotificationChannels>[0]) =>
            updateNotificationChannels(data),
        onSuccess: () => {
            queryClient.invalidateQueries({ queryKey: ["notification-channels"] })
            toast.success("Notification channels saved")
        },
        onError: (err) => {
            toast.error(err instanceof Error ? err.message : "Failed to save notification channels")
        },
    })
}

export function useTestNotificationChannel() {
    return useMutation({
        mutationFn: (channel: "telegram" | "gotify" | "ntfy") =>
            testNotificationChannel(channel),
    })
}
