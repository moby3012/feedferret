"use client";

import { useEffect } from "react";
import { useRouter } from "next/navigation";

function hasCookie(name: string): boolean {
  return document.cookie.split("; ").some((part) => part.startsWith(`${name}=`));
}

/**
 * Seeds the `timezone` cookie (see i18n/request.ts) with the browser's
 * detected IANA zone on a visitor's very first page load, so every timestamp
 * in the app renders in local time instead of the server's default (UTC in
 * most Docker deployments) without the user having to do anything. Once the
 * cookie exists — whether seeded here or set explicitly via the display
 * timezone setting (app/actions/timezone.ts) — this is a no-op; an explicit
 * choice is never overwritten.
 */
export function TimezoneSync() {
  const router = useRouter();

  useEffect(() => {
    if (hasCookie("timezone")) return;
    let detected: string;
    try {
      detected = Intl.DateTimeFormat().resolvedOptions().timeZone;
    } catch {
      return;
    }
    if (!detected) return;
    document.cookie = `timezone=${encodeURIComponent(detected)}; path=/; max-age=${365 * 24 * 60 * 60}; samesite=lax`;
    router.refresh();
  }, [router]);

  return null;
}
