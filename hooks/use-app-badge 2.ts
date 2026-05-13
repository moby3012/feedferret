"use client";

import { useEffect, useMemo } from "react";

type BadgeNavigator = Navigator & {
  setAppBadge?: (contents?: number) => Promise<void>;
  clearAppBadge?: () => Promise<void>;
};

export function getUnreadCountFromFeeds(feeds: Array<{ _count?: { articles?: number }; unreadCount?: number }>) {
  return feeds.reduce((sum, feed) => sum + (feed._count?.articles ?? feed.unreadCount ?? 0), 0);
}

export async function updateAppBadge(count: number) {
  if (typeof navigator === "undefined") return;
  const badgeNavigator = navigator as BadgeNavigator;
  try {
    if (count > 0 && badgeNavigator.setAppBadge) {
      await badgeNavigator.setAppBadge(count);
    } else if (badgeNavigator.clearAppBadge) {
      await badgeNavigator.clearAppBadge();
    }

    if ("serviceWorker" in navigator) {
      const registration = await navigator.serviceWorker.ready.catch(() => null);
      registration?.active?.postMessage({ type: count > 0 ? "SET_BADGE" : "CLEAR_BADGE", count });
    }
  } catch {
    // Badging is progressive and unsupported in many browsers.
  }
}

export function useUnreadBadgeCount(feeds: Array<{ _count?: { articles?: number }; unreadCount?: number }>) {
  return useMemo(() => getUnreadCountFromFeeds(feeds), [feeds]);
}

export function useAppBadge(count: number, enabled = true) {
  useEffect(() => {
    updateAppBadge(enabled ? count : 0);
  }, [count, enabled]);
}
