"use client";

import { useEffect, useMemo, useSyncExternalStore } from "react";

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

// ------------------------------------------------------------------ preference
// Settings → Benachrichtigungen → "Badge am App-Symbol": per device, DEFAULT ON
// (owner decision 2026-11-10). Stored only when switched off.

export const APP_BADGE_PREF_KEY = "feedferret:app-badge";
const PREF_EVENT = "feedferret:app-badge-pref";

export function readAppBadgeEnabled(): boolean {
  try {
    return localStorage.getItem(APP_BADGE_PREF_KEY) !== "off";
  } catch {
    return true;
  }
}

export function setAppBadgeEnabled(enabled: boolean) {
  try {
    if (enabled) localStorage.removeItem(APP_BADGE_PREF_KEY);
    else localStorage.setItem(APP_BADGE_PREF_KEY, "off");
  } catch {
    // Private mode: the switch still applies for this page view.
  }
  window.dispatchEvent(new Event(PREF_EVENT));
  // The worker sets the badge on push while no page is open: tell it too.
  if ("serviceWorker" in navigator) {
    void navigator.serviceWorker.ready
      .then((registration) => registration.active?.postMessage({ type: "BADGE_PREF", enabled }))
      .catch(() => {});
  }
}

function subscribePref(onChange: () => void) {
  window.addEventListener(PREF_EVENT, onChange);
  window.addEventListener("storage", onChange);
  return () => {
    window.removeEventListener(PREF_EVENT, onChange);
    window.removeEventListener("storage", onChange);
  };
}

/** The per-device badge switch (true during SSR: the default). */
export function useAppBadgeEnabled(): boolean {
  return useSyncExternalStore(subscribePref, readAppBadgeEnabled, () => true);
}
