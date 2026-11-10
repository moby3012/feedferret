"use client";

// "Back" on secondary routes (/settings, /manage-feeds): router.back() only
// when the user actually came from inside the app in this tab. Opened cold —
// a manifest shortcut, a bookmark, a new tab — there is no app entry behind
// it and back would leave the app, so go to the shell instead.
const KEY = "ff:in-app";

type RouterLike = { back(): void; replace(href: string): void };

export function markInAppNavigation() {
  try {
    sessionStorage.setItem(KEY, "1");
  } catch {
    /* private mode */
  }
}

export function cameFromApp(): boolean {
  try {
    return sessionStorage.getItem(KEY) === "1" && window.history.length > 1;
  } catch {
    return false;
  }
}

export function backOrHome(router: RouterLike) {
  if (cameFromApp()) router.back();
  else router.replace("/");
}
