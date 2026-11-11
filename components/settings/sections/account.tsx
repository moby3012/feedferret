"use client";

import { ApiPasswordSettings } from "@/components/api-password-settings";
import { useTranslations } from "next-intl";
import { useSession } from "next-auth/react";
import { useSignOut } from "@/components/shell/use-sign-out";
import { LogOut, Smartphone, Bookmark, User } from "lucide-react";
import { Button } from "@/components/ui/button";
import { SHOW_PWA_INSTALL_PROMPT_EVENT } from "@/components/pwa-install-prompt";
import { SubscribeBookmarklet } from "@/components/subscribe-bookmarklet";
import { PrefRow } from "@/components/settings/pref-row";
import { EmailSection } from "@/components/settings/sections/email";
import { PasswordSection } from "@/components/settings/sections/password";
import { TwoFactorSection } from "@/components/settings/sections/two-factor";
import { DeleteAccountSection } from "@/components/settings/sections/delete-account";
import { ApiTokenSection } from "@/components/settings/sections/api-tokens";

export function AccountSettings() {
  const t = useTranslations();
  const signOut = useSignOut();
  const { data: session } = useSession();

  return (
    <>
      {/* User Profile */}
      <section className="rounded-panel border border-border/65 bg-card/85 p-5 sm:p-6">
        <div className="flex flex-col gap-6 sm:flex-row sm:items-center sm:justify-between">
          <div className="flex items-start gap-4">
            <div className="ui-brand-icon flex h-12 w-12 shrink-0 items-center justify-center rounded-panel">
              <User className="h-5 w-5" />
            </div>
            <div>
              <h2 className="text-title-sm font-semibold tracking-title">{t("settings.userProfile")}</h2>
              <p className="mt-1 max-w-xl text-body-sm leading-6 text-muted-foreground">
                {t("settings.signedInAs")}{" "}
                <span className="font-medium text-foreground">
                  {session?.user?.email || t("settings.unknownUser")}
                </span>
              </p>
            </div>
          </div>
          <Button
            variant="outline"
            onClick={() => signOut({ callbackUrl: "/" })}
            className="h-11 rounded-panel border-border/70 bg-background/70 px-5"
          >
            <LogOut className="me-2 h-4 w-4" />
            {t("settings.signOut")}
          </Button>
        </div>
      </section>

      {/* Change email (step-up protected) */}
      <EmailSection currentEmail={session?.user?.email ?? null} />

      {/* Change password */}
      <PasswordSection />

      {/* Two-factor authentication */}
      <TwoFactorSection />

      {/* API Access */}
      <ApiPasswordSettings />
      <ApiTokenSection />

      {/* Add to Home Screen */}
      <PrefRow
        icon={Smartphone}
        title={t("pwa.title")}
        description={t("pwa.description")}
      >
        <Button
          type="button"
          variant="outline"
          onClick={() => window.dispatchEvent(new Event(SHOW_PWA_INSTALL_PROMPT_EVENT))}
          className="h-11 rounded-panel border-border/70 bg-background/70 px-5"
        >
          {t("pwa.showInstructions")}
        </Button>
      </PrefRow>

      {/* Desktop bookmarklet → reuses the PWA share-target deep link */}
      <PrefRow
        icon={Bookmark}
        title={t("settingsBookmarklet.title")}
        description={t("settingsBookmarklet.description")}
      >
        <SubscribeBookmarklet />
      </PrefRow>

      {/* Danger Zone: Delete Account */}
      <DeleteAccountSection />
    </>
  );
}
