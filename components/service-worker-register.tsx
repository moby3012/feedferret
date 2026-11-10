"use client";

import { useEffect } from "react";
import { usePathname } from "next/navigation";
import { announceOfflineSession } from "@/features/offline/session";
import { clearAllOffline } from "@/features/offline/store";

export function ServiceWorkerRegister() {
  const pathname = usePathname();
  // The login page means "no session": whatever a previous session left in the
  // offline store (expired session, shared device) goes with it.
  useEffect(() => {
    if (pathname === "/login") void clearAllOffline().then(() => announceOfflineSession(null));
  }, [pathname]);

  useEffect(() => {
    if (!("serviceWorker" in navigator)) return;

    const canRegister =
      window.location.protocol === "https:" ||
      window.location.hostname === "localhost" ||
      window.location.hostname === "127.0.0.1";

    if (!canRegister) return;

    const register = () => {
      navigator.serviceWorker.register("/sw.js", { scope: "/" }).catch(() => {
        // Service worker support should be progressive; ignore registration failures.
      });
    };

    if (document.readyState === "complete") register();
    else window.addEventListener("load", register, { once: true });

    return () => window.removeEventListener("load", register);
  }, []);

  return null;
}
