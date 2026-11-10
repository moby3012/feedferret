"use client"

import { useEffect, useMemo, useRef } from "react"
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query"
import { useTranslations } from "next-intl"
import { getFeeds, getCategories, refreshAllFeeds, refreshFeed, importOpml, exportOpml, exportUserData, addFeed, deleteFeed, updateFeed, addCategory, updateCategory, deleteCategory, updateCategoryOrder, updateFeedOrder, getLabels, createLabel, updateLabel, deleteLabel, getSavedSearches, createSavedSearch, updateSavedSearch, deleteSavedSearch, setSavedSearchSharing, getFeedHealth, applyRetentionPolicies, getAutoReadRules, createAutoReadRule, updateAutoReadRule, deleteAutoReadRule, applyAutoReadRulesNow, previewAutoReadRule, migrateKeywordAlertsToRules, getKeywordAlerts, createKeywordAlert, updateKeywordAlert, deleteKeywordAlert, previewKeywordAlertMatches, testKeywordAlert, getNotifications, markNotificationRead, markAllNotificationsRead, previewFeedExtraction, summarizeArticle, releaseArticleSpoiler, releaseAllSpoilers, suggestFeedFromUrl, createFeedFromPage, proposeAiFeedConfig, proposeAiFullTextSelector, getRsshubStatus, previewRsshubFeed, getChangedetectionStatus, createChangedetectionFeed } from "@/app/actions/feeds"
import { updateProfile, getEmailChangeMailStatus, changePassword, updateGlobalSettings, getReadingPreferences, getDigestSettings, updateDigestSettings, sendTestDigest, previewDigest, getTwoFactorStatus, beginTwoFactorSetup, confirmTwoFactorSetup, disableTwoFactor, getAiSettings, updateAiSettings, testAiConnection, getContentFetchSettings, updateContentFetchSettings, testContentFetchConnection, getNotificationChannels, updateNotificationChannels, testNotificationChannel, getNotificationChannelStatus } from "@/app/actions/settings"
import { getExportSettings, updateExportSettings, testWallabagExportConnection, buildObsidianExportLink, exportArticleToWallabag } from "@/app/actions/export"
import { updateUiLanguage } from "@/app/actions/locale"
import { updateDisplayTimezone } from "@/app/actions/timezone"
import { toast } from "sonner"
import { invalidateAfterSync, invalidateArticleQueries, invalidateCounts, markListsStale, removeCachedArticle, removeLabelFromCachedArticles, restoreArticleCaches, snapshotArticleCaches } from "@/features/articles/cache"
import { qk } from "@/features/articles/keys"
import type { Counts } from "@/features/bootstrap/types"
import { useCountsQuery } from "@/features/bootstrap/queries"
import { useArticleActions, useIsMarkingViewRead, type MarkViewScope } from "@/features/articles/mutations"

export type { MarkViewScope }

// Entity queries refetch on invalidation only (no polling, no focus refetch):
// live numbers come from `["counts"]` (features/bootstrap/queries.ts), which
// reconciles every 120 s. `_count` on feeds / labels is the server's value at
// fetch time and is kept for the settings pages; the reader shell reads counts
// only from `useCounts()`.
const ENTITY_QUERY = { staleTime: 5 * 60_000, refetchOnWindowFocus: false } as const

export function useFeeds(enabled = true) {
    return useQuery({
        queryKey: ["feeds"],
        queryFn: () => getFeeds(),
        enabled,
        ...ENTITY_QUERY,
    })
}

export function useCategories(enabled = true) {
    return useQuery({
        queryKey: ["categories"],
        queryFn: () => getCategories(),
        enabled,
    })
}

export function useLabels(enabled = true) {
    const query = useQuery({
        queryKey: ["labels"],
        queryFn: () => getLabels(),
        enabled,
        ...ENTITY_QUERY,
    })
    // Unread per label from the live counts (optimistic + reconciled), so a
    // label badge moves with every toggle without refetching labels.
    const counts = useCountsQuery(enabled).data
    const data = useMemo(
        () => (counts && query.data
            ? query.data.map((label) => ({ ...label, _count: { ...label._count, articles: counts.byLabel[label.id] ?? 0 } }))
            : query.data),
        [counts, query.data],
    )
    return { ...query, data }
}

/** Starred total (sidebar). Adapter over `useCounts()`; kept for the pre-shell sidebar. */
export function useStarredCount() {
    const query = useCountsQuery()
    return { ...query, data: query.data?.starred }
}

/** Read-later total (sidebar). Adapter over `useCounts()`. */
export function useReadLaterCount() {
    const query = useCountsQuery()
    return { ...query, data: query.data?.later }
}

/** Spoiler total (sidebar). Adapter over `useCounts()`. */
export function useSpoilerCount() {
    const query = useCountsQuery()
    return { ...query, data: query.data?.spoiler }
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

/** Mutation keys of the explicit feed syncs: either one running = the shell's `isRefreshing`. */
export const REFRESH_ALL_KEY = ["refresh-all"] as const
export const REFRESH_FEED_KEY = ["refresh-feed"] as const

/**
 * Explicit refresh ("Aktualisieren", pull-to-refresh, `r`). Stays pending
 * until the counts are refetched, so the end of `isRefreshing` means "fresh
 * numbers": the live region announces them, and the bound list's pill
 * (`NewItemsPill`) probes once more and applies — or owes the update.
 * New rows are buffered behind "↑ N neu" (never inserted under the finger).
 */
export function useRefresh() {
    const queryClient = useQueryClient()
    return useMutation({
        mutationKey: REFRESH_ALL_KEY,
        mutationFn: () => refreshAllFeeds(),
        onSuccess: async () => {
            queryClient.invalidateQueries({ queryKey: ["feeds"] })
            await invalidateAfterSync(queryClient)
        },
    })
}

/** Single-feed refresh: same end-of-refresh path as `useRefresh` (drives `isRefreshing`). */
export function useRefreshFeed() {
    const queryClient = useQueryClient()
    return useMutation({
        mutationKey: REFRESH_FEED_KEY,
        mutationFn: (feedId: string) => refreshFeed(feedId),
        onSuccess: async () => {
            queryClient.invalidateQueries({ queryKey: ["feeds"] })
            queryClient.invalidateQueries({ queryKey: ["feed-health"] })
            toast.success("Feed refreshed")
            await invalidateAfterSync(queryClient)
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

export function useRsshubStatus() {
    return useQuery({
        queryKey: ["rsshub-status"],
        queryFn: () => getRsshubStatus(),
        staleTime: 5 * 60_000,
    })
}

export function usePreviewRsshubFeed() {
    return useMutation({
        mutationFn: (input: Parameters<typeof previewRsshubFeed>[0]) => previewRsshubFeed(input),
    })
}

export function useChangedetectionStatus() {
    return useQuery({
        queryKey: ["changedetection-status"],
        queryFn: () => getChangedetectionStatus(),
        staleTime: 5 * 60_000,
    })
}

export function useCreateChangedetectionFeed() {
    return useMutation({
        mutationFn: (input: Parameters<typeof createChangedetectionFeed>[0]) => createChangedetectionFeed(input),
    })
}

export function useUpdateFeed() {
    const queryClient = useQueryClient()
    return useMutation({
        mutationFn: ({ feedId, data }: { feedId: string; data: Parameters<typeof updateFeed>[1] }) =>
            updateFeed(feedId, data),
        onSuccess: () => {
            queryClient.invalidateQueries({ queryKey: ["feeds"] })
            // F6: the Health tab's mute toggle also goes through this mutation.
            queryClient.invalidateQueries({ queryKey: ["feed-health"] })
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
                invalidateArticleQueries(queryClient)
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
            invalidateArticleQueries(queryClient)
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

type ReadingPreferences = Awaited<ReturnType<typeof getReadingPreferences>>

/** `initialData`: the server's copy (root layout), so the first render already has it — no request at boot. */
export function useReadingPreferences(enabled = true, initialData?: ReadingPreferences | null) {
    return useQuery({
        queryKey: ["reading-preferences"],
        queryFn: () => getReadingPreferences(),
        enabled,
        initialData: initialData ?? undefined,
    })
}

export function useUpdateProfile() {
    return useMutation({
        mutationFn: (data: Parameters<typeof updateProfile>[0]) => updateProfile(data),
    })
}

export function useEmailChangeMailStatus() {
    return useQuery({
        queryKey: ["email-change-mail-status"],
        queryFn: () => getEmailChangeMailStatus(),
        staleTime: 5 * 60_000,
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

export function useUpdateDisplayTimezone() {
    const queryClient = useQueryClient()
    return useMutation({
        mutationFn: (data: { timezone: string | null; effectiveTimezone?: string }) =>
            updateDisplayTimezone(data.timezone, data.effectiveTimezone),
        onMutate: async (data) => {
            await queryClient.cancelQueries({ queryKey: ["reading-preferences"] })
            const prev = queryClient.getQueryData(["reading-preferences"])
            queryClient.setQueryData(["reading-preferences"], (old: any) =>
                old ? { ...old, displayTimezone: data.timezone } : old,
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
            // Rows carry label ids only; name/colour come from the labels query.
            queryClient.invalidateQueries({ queryKey: ["labels"] })
        },
    })
}

export function useDeleteLabel() {
    const queryClient = useQueryClient()
    return useMutation({
        mutationFn: (labelId: string) => deleteLabel(labelId),
        onSuccess: (_result, labelId) => {
            queryClient.invalidateQueries({ queryKey: ["labels"] })
            removeLabelFromCachedArticles(queryClient, labelId)
            markListsStale(queryClient)
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
            invalidateArticleQueries(queryClient)
            toast.success("Rule deleted")
        },
    })
}

export function useReleaseArticleSpoiler() {
    const queryClient = useQueryClient()
    return useMutation({
        mutationFn: (articleId: string) => releaseArticleSpoiler(articleId),
        onMutate: async (articleId) => {
            const spoilerLists = qk.listScope("v:spoiler")
            await queryClient.cancelQueries({ queryKey: spoilerLists })
            const snapshots = queryClient.getQueriesData({ queryKey: spoilerLists })
            removeCachedArticle(queryClient, articleId)
            queryClient.setQueryData<Counts>(qk.counts, (c) => (c ? { ...c, spoiler: Math.max(0, c.spoiler - 1) } : c))
            return { snapshots }
        },
        onError: (_err, _id, ctx) => {
            restoreArticleCaches(queryClient, ctx?.snapshots)
            invalidateCounts(queryClient)
        },
        onSuccess: () => {
            // The row now belongs to the regular views: they pick it up on rebind.
            markListsStale(queryClient)
            invalidateCounts(queryClient)
        },
    })
}

export function useReleaseAllSpoilers() {
    const queryClient = useQueryClient()
    return useMutation({
        mutationFn: () => releaseAllSpoilers(),
        onSuccess: () => {
            invalidateArticleQueries(queryClient)
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
            invalidateArticleQueries(queryClient)
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

/**
 * Notification list. No own polling: it refetches when the unread number in
 * `["counts"]` (120 s reconcile) changes.
 */
export function useNotifications() {
    const queryClient = useQueryClient()
    const unread = useCountsQuery().data?.notifications
    const seen = useRef<number | undefined>(undefined)
    useEffect(() => {
        if (unread === undefined) return
        if (seen.current !== undefined && seen.current !== unread) {
            queryClient.invalidateQueries({ queryKey: ["notifications"], exact: true })
        }
        seen.current = unread
    }, [unread, queryClient])
    return useQuery({
        queryKey: ["notifications"],
        queryFn: () => getNotifications(),
        refetchOnWindowFocus: false,
    })
}

/** Unread notifications (bell badge). Adapter over `useCounts()`. */
export function useUnreadNotificationCount() {
    const query = useCountsQuery()
    return { ...query, data: query.data?.notifications }
}

export function useMarkNotificationRead() {
    const queryClient = useQueryClient()
    return useMutation({
        mutationFn: (notificationId: string) => markNotificationRead(notificationId),
        onSuccess: () => {
            queryClient.invalidateQueries({ queryKey: ["notifications"] })
            invalidateCounts(queryClient)
        },
    })
}

export function useMarkAllNotificationsRead() {
    const queryClient = useQueryClient()
    return useMutation({
        mutationFn: () => markAllNotificationsRead(),
        onSuccess: () => {
            queryClient.invalidateQueries({ queryKey: ["notifications"] })
            invalidateCounts(queryClient)
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
            // "Sachliche Titel bei Clickbait" changes list rows (displayTitle).
            queryClient.invalidateQueries({ queryKey: ["list"] })
            // Provider / cap / auto changes the briefing card's state (K2).
            queryClient.invalidateQueries({ queryKey: ["briefing"] })
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

// ── F5: Export destinations (Obsidian / Wallabag) ───────────────────────────

export function useExportSettings() {
    return useQuery({
        queryKey: ["export-settings"],
        queryFn: () => getExportSettings(),
    })
}

export function useUpdateExportSettings() {
    const queryClient = useQueryClient()
    return useMutation({
        mutationFn: (data: Parameters<typeof updateExportSettings>[0]) => updateExportSettings(data),
        onSuccess: () => {
            queryClient.invalidateQueries({ queryKey: ["export-settings"] })
            toast.success("Export settings saved")
        },
        onError: (err) => {
            toast.error(err instanceof Error ? err.message : "Export settings could not be saved. Try again.")
        },
    })
}

export function useTestWallabagExportConnection() {
    return useMutation({
        mutationFn: (overrides?: Parameters<typeof testWallabagExportConnection>[0]) => testWallabagExportConnection(overrides),
    })
}

export function useBuildObsidianExportLink() {
    return useMutation({
        mutationFn: (articleId: string) => buildObsidianExportLink(articleId),
    })
}

export function useExportArticleToWallabag() {
    return useMutation({
        mutationFn: (articleId: string) => exportArticleToWallabag(articleId),
    })
}

export function useSummarizeArticle() {
    const queryClient = useQueryClient()
    const t = useTranslations("articleReader")
    return useMutation({
        mutationFn: (articleId: string) => summarizeArticle(articleId),
        onSuccess: () => {
            invalidateArticleQueries(queryClient)
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

/**
 * Bulk "mark this view read" with the Undo toast. Adapter over
 * `useArticleActions().markViewRead` (features/articles/mutations.ts) for the
 * pre-shell sidebar.
 */
export function useMarkViewRead() {
    const { markViewRead } = useArticleActions()
    return { markViewRead, isPending: useIsMarkingViewRead() }
}
