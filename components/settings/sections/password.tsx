"use client";

import { useTranslations } from "next-intl";
import { Lock } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useChangePassword } from "@/hooks/use-rss-data";
import { useState } from "react";
import { Input } from "@/components/ui/input";
import { toast } from "sonner";

export function PasswordSection() {
  const t = useTranslations();
  const changePassword = useChangePassword();
  const [currentPassword, setCurrentPassword] = useState("");
  const [newPassword, setNewPassword] = useState("");

  const handleSubmit = async () => {
    if (newPassword.length < 8) {
      toast.error(t("profile.passwordTooShort"));
      return;
    }
    try {
      const result = await changePassword.mutateAsync({ currentPassword, newPassword });
      if (result.success) {
        toast.success(t("profile.passwordChanged"));
        setCurrentPassword("");
        setNewPassword("");
      } else {
        toast.error(result.error ?? t("profile.passwordChangeFailed"));
      }
    } catch {
      toast.error(t("profile.passwordChangeFailed"));
    }
  };

  return (
    <section className="rounded-panel border border-border/65 bg-card/85 p-5 sm:p-6">
      <div className="flex items-start gap-4 mb-6">
        <div className="ui-brand-icon flex h-12 w-12 shrink-0 items-center justify-center rounded-panel">
          <Lock className="h-5 w-5" />
        </div>
        <div>
          <h2 className="text-title-sm font-semibold tracking-title">{t("profile.changePassword")}</h2>
          <p className="mt-1 text-body-sm leading-6 text-muted-foreground">
            {t("profile.changePasswordDescription")}
          </p>
        </div>
      </div>

      <div className="grid gap-4 sm:max-w-sm">
        <div className="grid gap-1.5">
          <label className="text-body-sm font-medium" htmlFor="current-password-input">{t("profile.currentPassword")}</label>
          <Input
            id="current-password-input"
            type="password"
            autoComplete="current-password"
            value={currentPassword}
            onChange={(e) => setCurrentPassword(e.target.value)}
            className="h-10 rounded-panel"
          />
        </div>
        <div className="grid gap-1.5">
          <label className="text-body-sm font-medium" htmlFor="new-password-input">{t("profile.newPassword")}</label>
          <Input
            id="new-password-input"
            type="password"
            autoComplete="new-password"
            value={newPassword}
            onChange={(e) => setNewPassword(e.target.value)}
            className="h-10 rounded-panel"
          />
          <p className="text-footnote text-muted-foreground">{t("profile.newPasswordHint")}</p>
        </div>
        <Button
          type="button"
          onClick={handleSubmit}
          disabled={changePassword.isPending || !currentPassword || !newPassword}
          className="h-11 w-fit rounded-panel px-5"
        >
          {changePassword.isPending ? t("profile.updating") : t("profile.updatePassword")}
        </Button>
      </div>
    </section>
  );
}
