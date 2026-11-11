"use client";

import { useTranslations } from "next-intl";
import { useSession } from "next-auth/react";
import { User, AlertTriangle } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useUpdateProfile, useEmailChangeMailStatus } from "@/hooks/use-rss-data";
import { useState } from "react";
import { Input } from "@/components/ui/input";
import { cancelPendingEmailChange } from "@/app/actions/settings";
import { AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle } from "@/components/ui/alert-dialog";
import { toast } from "sonner";

export function EmailSection({ currentEmail }: { currentEmail: string | null }) {
  const t = useTranslations();
  const updateProfile = useUpdateProfile();
  const mailStatus = useEmailChangeMailStatus();
  const { update: updateSession } = useSession();
  const [email, setEmail] = useState("");
  const [proof, setProof] = useState("");
  const [cancelOpen, setCancelOpen] = useState(false);
  const [cancelling, setCancelling] = useState(false);
  const handleCancel = async () => {
    setCancelling(true);
    try {
      await cancelPendingEmailChange();
      await mailStatus.refetch();
      setCancelOpen(false);
    } catch {
      toast.error(t("profile.emailCancelFailed"));
    } finally {
      setCancelling(false);
    }
  };

  const handleSubmit = async (address = email) => {
    const next = address.trim().toLowerCase();
    if (!next || next === currentEmail) return;
    try {
      // The proof field takes the current login password or a TOTP code; the
      // server tries both (passwordless accounts: a sign-in < 10 min ago).
      const result = await updateProfile.mutateAsync({ email: next, currentPassword: proof, totp: proof });
      if (result.success) {
        if (result.emailPending && result.emailNotice === "failed") toast.error(t("profile.emailPendingSendFailed"));
        else toast.success(result.emailPending ? t("profile.emailPending", { email: result.emailPending }) : t("profile.emailChanged"));
        await mailStatus.refetch();
        if (!result.emailPending && result.emailNotice === "failed") toast.warning(t("profile.emailChangeNoticeFailed"));
        setEmail("");
        setProof("");
        await updateSession?.().catch(() => undefined);
        return;
      }
      const messages = {
        emailPendingSendFailed: t("profile.emailPendingSendFailed"),
        stepUpRequired: t("apiPassword.stepUpRequired"),
        reloginRequired: t("apiPassword.reloginRequired"),
        rateLimited: t("profile.emailChangeRateLimited"),
        invalidEmail: t("profile.invalidEmail"),
        emailTaken: t("profile.emailTaken"),
      } as const;
      toast.error(messages[result.code] ?? t("profile.emailChangeFailed"));
    } catch {
      toast.error(t("profile.emailChangeFailed"));
    }
  };

  return (
    <section className="rounded-panel border border-border/65 bg-card/85 p-5 sm:p-6" data-testid="email-change-section">
      <div className="flex items-start gap-4 mb-6">
        <div className="ui-brand-icon flex h-12 w-12 shrink-0 items-center justify-center rounded-panel">
          <User className="h-5 w-5" />
        </div>
        <div>
          <h2 className="text-title-sm font-semibold tracking-title">{t("profile.changeEmail")}</h2>
          <p className="mt-1 text-body-sm leading-6 text-muted-foreground">{t("apiPassword.emailChangeWarning")}</p>
        </div>
      </div>

      <div className="grid gap-4 sm:max-w-sm">
        {mailStatus.data?.emailPending ? <div role="status" className="space-y-2 text-body-sm">
          <p>{t("profile.emailPending", { email: mailStatus.data.emailPending })}</p>
          <Button variant="outline" disabled={updateProfile.isPending} onClick={() => handleSubmit(mailStatus.data!.emailPending!)}>{t("profile.emailResend")}</Button>
          <Button variant="outline" disabled={cancelling} onClick={() => setCancelOpen(true)}>{t("profile.emailCancel")}</Button>
        </div> : null}
        <div className="grid gap-1.5">
          <label className="text-body-sm font-medium" htmlFor="new-email-input">{t("profile.newEmail")}</label>
          <Input
            id="new-email-input"
            type="email"
            autoComplete="email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            placeholder={currentEmail ?? undefined}
            className="h-10 rounded-panel"
          />
        </div>
        <div className="grid gap-1.5">
          <label className="text-body-sm font-medium" htmlFor="email-step-up-input">{t("profile.emailStepUp")}</label>
          <Input
            id="email-step-up-input"
            type="password"
            autoComplete="current-password"
            value={proof}
            onChange={(e) => setProof(e.target.value)}
            aria-describedby="email-step-up-hint"
            className="h-10 rounded-panel"
          />
          <p id="email-step-up-hint" className="text-footnote text-muted-foreground">{t("profile.emailStepUpHint")}</p>
        </div>
        {mailStatus.data && !mailStatus.data.mailConfigured ? (
          <p role="note" className="flex items-start gap-2 rounded-panel border border-warning/20 bg-warning/10 p-3 text-body-sm text-warning" data-testid="email-change-no-mail">
            <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" />
            <span>{t("profile.emailChangeNoMail")}</span>
          </p>
        ) : null}
        <Button
          type="button"
          onClick={() => handleSubmit()}
          disabled={updateProfile.isPending || !email.trim() || email.trim().toLowerCase() === currentEmail}
          className="h-11 w-fit rounded-panel px-5"
        >
          {updateProfile.isPending ? t("profile.updating") : t("profile.updateEmail")}
        </Button>
      </div>
      <AlertDialog open={cancelOpen} onOpenChange={setCancelOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{t("profile.emailCancel")}</AlertDialogTitle>
            <AlertDialogDescription>{t("profile.emailCancelConfirm")}</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={cancelling}>{t("profile.emailCancelKeep")}</AlertDialogCancel>
            <AlertDialogAction disabled={cancelling} onClick={event => { event.preventDefault(); void handleCancel(); }}>{t("profile.emailCancel")}</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </section>
  );
}
