"use client";

import { useCallback } from "react";
import { useTranslations } from "next-intl";
import { toast } from "sonner";
import { SignOutError, signOut } from "@/lib/logout";

/**
 * `signOut` for UI: a sign-out that could not happen (offline / the session survived the retries) is
 * reported as a toast and the user stays where they are — nothing was wiped. Resolves to whether it went through.
 */
export function useSignOut() {
  const t = useTranslations("common");
  return useCallback(
    async (options?: Parameters<typeof signOut>[0]): Promise<boolean> => {
      try {
        await signOut(options);
        return true;
      } catch (error) {
        if (!(error instanceof SignOutError)) throw error;
        toast.error(t(error.code === "offline" ? "signOutNeedsConnection" : "signOutFailed"));
        return false;
      }
    },
    [t],
  );
}
