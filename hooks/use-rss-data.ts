"use client"

import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query"
import { getFeeds, getArticles, getCategories, toggleArticleRead, toggleArticleStarred, toggleArticleReadLater, refreshAllFeeds, refreshFeed, importOpml, exportOpml, exportUserData, addFeed, deleteFeed, updateFeed, addCategory, updateCategory, deleteCategory, getStarredCount, getReadLaterCount, updateCategoryOrder, updateFeedOrder, markAllAsRead, fetchFullText, getLabels, createLabel, updateLabel, deleteLabel, setArticleLabels, getSavedSearches, createSavedSearch, updateSavedSearch, deleteSavedSearch, setSavedSearchSharing, getFeedHealth, applyRetentionPolicies, getAutoReadRules, createAutoReadRule, updateAutoReadRule, deleteAutoReadRule, applyAutoReadRulesNow, previewAutoReadRule, migrateKeywordAlertsToRules, getKeywordAlerts, createKeywordAlert, updateKeywordAlert, deleteKeywordAlert, previewKeywordAlertMatches, testKeywordAlert, getNotifications, getUnreadNotificationCount, markNotificationRead, markAllNotificationsRead, previewFeedExtraction, summarizeArticle } from "@/app/actions/feeds"
import { updateProfile, updateGlobalSettings, getReadingPreferences, getDigestSettings, updateDigestSettings, sendTestDigest, getTwoFactorStatus, beginTwoFactorSetup, confirmTwoFactorSetup, disableTwoFactor, getAiSettings, updateAiSettings, testAiConnection } from "@/app/actions/settings"
import { getWebhooks, createWebhook, updateWebhook, deleteWebhook, rotateWebhookSecret, getWebhookDeliveries, sendTestWebhook } from "@/app/actions/webhooks"
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

export function useLabels(enabled = true) {
    return useQuery({
        queryKey: ["labels"],
        queryFn: () => getLabels(),
        enabled,
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

            // Find the article in any cached list to know which feed to update
            let affectedFeedId: string | undefined
            for (const [, old] of snapshots) {
                if (!Array.isArray(old)) continue
                const hit = old.find((a: any) => a.id === articleId)
                if (hit) {
                    affectedFeedId = hit.feedId ?? hit.feed?.id
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

            return { snapshots, feedsSnapshot }
        },
        onError: (_error, _variables, context) => {
            context?.snapshots?.forEach(([queryKey, data]) => {
                queryClient.setQueryData(queryKey, data)
            })
            if (context?.feedsSnapshot) {
                queryClient.setQueryData(["feeds"], context.feedsSnapshot)
            }
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
            toast.error(error instanceof Error ? error.message : "Refresh failed")
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
            toast.error(error instanceof Error ? error.message : "Export failed")
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

export function useUpdateGlobalSettings() {
    const queryClient = useQueryClient()
    return useMutation({
        mutationFn: (data: Parameters<typeof updateGlobalSettings>[0]) =>
            updateGlobalSettings(data),
        onSuccess: () => {
            queryClient.invalidateQueries({ queryKey: ["reading-preferences"] })
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
            if (!Array.isArray(feedsSnapshot)) return { feedsSnapshot }
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
            return { feedsSnapshot }
        },
        onError: (_error, _variables, context) => {
            if (context?.feedsSnapshot) {
                queryClient.setQueryData(["feeds"], context.feedsSnapshot)
            }
        },
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
        }) => createAutoReadRule(data),
        onSuccess: () => {
            queryClient.invalidateQueries({ queryKey: ["auto-read-rules"] })
            toast.success("Rule created")
        },
        onError: (error) => {
            toast.error(error instanceof Error ? error.message : "Could not create rule")
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
            }>
        }) => updateAutoReadRule(ruleId, data),
        onSuccess: () => {
            queryClient.invalidateQueries({ queryKey: ["auto-read-rules"] })
        },
        onError: (error) => {
            toast.error(error instanceof Error ? error.message : "Could not update rule")
        },
    })
}

export function useDeleteAutoReadRule() {
    const queryClient = useQueryClient()
    return useMutation({
        mutationFn: (ruleId: string) => deleteAutoReadRule(ruleId),
        onSuccess: () => {
            queryClient.invalidateQueries({ queryKey: ["auto-read-rules"] })
            toast.success("Rule deleted")
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
            toast.error(error instanceof Error ? error.message : "Failed to apply rules")
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
            toast.error(error instanceof Error ? error.message : "Migration failed")
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
            toast.error(error instanceof Error ? error.message : "Could not create alert")
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
            toast.error(error instanceof Error ? error.message : "Could not update alert")
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
            toast.error(error instanceof Error ? error.message : "Could not update sharing")
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
            toast.error(error instanceof Error ? error.message : "Failed to save digest settings")
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
            toast.error(error instanceof Error ? error.message : "Failed to send test digest")
        },
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
            toast.error(error instanceof Error ? error.message : "Could not start 2FA setup")
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
            toast.error(error instanceof Error ? error.message : "Could not enable 2FA")
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
            toast.error(error instanceof Error ? error.message : "Could not disable 2FA")
        },
    })
}

export function useWebhooks() {
    return useQuery({
        queryKey: ["webhooks"],
        queryFn: () => getWebhooks(),
        staleTime: 30_000,
    })
}

export function useCreateWebhook() {
    const queryClient = useQueryClient()
    return useMutation({
        mutationFn: (data: { name: string; url: string; events: string[]; feedFilter?: string[] | null }) =>
            createWebhook(data),
        onSuccess: () => {
            queryClient.invalidateQueries({ queryKey: ["webhooks"] })
        },
        onError: (error) => {
            toast.error(error instanceof Error ? error.message : "Could not create webhook")
        },
    })
}

export function useUpdateWebhook() {
    const queryClient = useQueryClient()
    return useMutation({
        mutationFn: ({ id, data }: { id: string; data: Parameters<typeof updateWebhook>[1] }) =>
            updateWebhook(id, data),
        onSuccess: () => {
            queryClient.invalidateQueries({ queryKey: ["webhooks"] })
        },
        onError: (error) => {
            toast.error(error instanceof Error ? error.message : "Could not update webhook")
        },
    })
}

export function useDeleteWebhook() {
    const queryClient = useQueryClient()
    return useMutation({
        mutationFn: (id: string) => deleteWebhook(id),
        onSuccess: () => {
            queryClient.invalidateQueries({ queryKey: ["webhooks"] })
            toast.success("Webhook deleted")
        },
        onError: (error) => {
            toast.error(error instanceof Error ? error.message : "Could not delete webhook")
        },
    })
}

export function useRotateWebhookSecret() {
    return useMutation({
        mutationFn: (id: string) => rotateWebhookSecret(id),
        onError: (error) => {
            toast.error(error instanceof Error ? error.message : "Could not rotate secret")
        },
    })
}

export function useWebhookDeliveries(webhookId: string | null) {
    return useQuery({
        queryKey: ["webhook-deliveries", webhookId],
        queryFn: () => getWebhookDeliveries(webhookId!),
        enabled: !!webhookId,
        staleTime: 10_000,
    })
}

export function useSendTestWebhook() {
    return useMutation({
        mutationFn: (id: string) => sendTestWebhook(id),
        onSuccess: (result) => {
            if (result.ok) {
                toast.success(`Test delivered (HTTP ${result.status})`)
            } else {
                toast.error(`Test failed: ${(result as any).error ?? `HTTP ${result.status}`}`)
            }
        },
        onError: (error) => {
            toast.error(error instanceof Error ? error.message : "Test failed")
        },
    })
}

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
            toast.error(err instanceof Error ? err.message : "Save failed")
        },
    })
}

export function useTestAiConnection() {
    return useMutation({
        mutationFn: () => testAiConnection(),
    })
}

export function useSummarizeArticle() {
    const queryClient = useQueryClient()
    return useMutation({
        mutationFn: (articleId: string) => summarizeArticle(articleId),
        onSuccess: () => {
            queryClient.invalidateQueries({ queryKey: ["articles"] })
        },
        onError: (err) => {
            toast.error(err instanceof Error ? err.message : "Summarize failed")
        },
    })
}
