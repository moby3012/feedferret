"use client";

import { useTranslations } from "next-intl";
import { signOut } from "@/lib/logout";
import { useRouter } from "next/navigation";
import { Trash2, AlertTriangle } from "lucide-react";
import { AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle } from "@/components/ui/alert-dialog";
import { deleteOwnAccount } from "@/app/actions/account";
import { Button } from "@/components/ui/button";
import { useState } from "react";
import { Input } from "@/components/ui/input";
import { toast } from "sonner";

export function DeleteAccountSection() {
  const t = useTranslations();
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [loading, setLoading] = useState(false);
  const [confirmText, setConfirmText] = useState("");
  // The required confirmation phrase and the input placeholder both derive
  // from this single translation key so the check can never mismatch the
  // locale shown to the user (see U-5 in the UX audit).
  const confirmPhrase = t("deleteAccount.confirmPlaceholder");
  const confirmMatches = confirmText.trim().toLowerCase() === confirmPhrase.trim().toLowerCase();

  const handleDelete = async () => {
    setLoading(true);
    try {
      const result = await deleteOwnAccount();
      if ("error" in result) {
        toast.error(result.error);
        setLoading(false);
        return;
      }
      toast.success(t("deleteAccount.accountDeleted"));
      await signOut({ callbackUrl: "/login" });
    } catch {
      toast.error(t("deleteAccount.deletionFailed"));
      setLoading(false);
    }
  };

  return (
    <>
      <section className="rounded-2xl border border-destructive/25 bg-destructive/5 p-5 shadow-sm sm:p-6">
        <div className="flex flex-col gap-6 sm:flex-row sm:items-center sm:justify-between">
          <div className="flex items-start gap-4">
            <div className="flex h-12 w-12 shrink-0 items-center justify-center rounded-2xl bg-destructive/10 text-destructive">
              <AlertTriangle className="h-5 w-5" />
            </div>
            <div>
              <h2 className="text-lg font-semibold tracking-title">{t("deleteAccount.title")}</h2>
              <p className="mt-1 max-w-xl text-sm leading-6 text-muted-foreground">
                {t("deleteAccount.description")}
              </p>
            </div>
          </div>
          <Button
            variant="outline"
            onClick={() => setOpen(true)}
            className="h-11 rounded-2xl border-destructive/40 text-destructive hover:bg-destructive/10 px-5 shrink-0"
          >
            <Trash2 className="me-2 h-4 w-4" />
            {t("deleteAccount.deleteMyAccount")}
          </Button>
        </div>
      </section>

      <AlertDialog open={open} onOpenChange={setOpen}>
        <AlertDialogContent className="rounded-3xl border-border/70 bg-background">
          <AlertDialogHeader>
            <AlertDialogTitle className="flex items-center gap-2 text-destructive">
              <AlertTriangle className="h-5 w-5" />
              {t("deleteAccount.confirmDialogTitle")}
            </AlertDialogTitle>
            <AlertDialogDescription className="space-y-3">
              <span className="block">
                {t("deleteAccount.confirmDialogDescription")}
                <strong> {t("deleteAccount.cannotBeUndone")}</strong>
              </span>
              <span className="block mt-3 text-sm font-medium text-foreground">
                {t("deleteAccount.typeToConfirm")}
              </span>
              <Input
                value={confirmText}
                onChange={(e) => setConfirmText(e.target.value)}
                placeholder={confirmPhrase}
                className="rounded-2xl border-border/70 bg-background/70"
              />
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel className="rounded-2xl" onClick={() => setConfirmText("")}>
              {t("deleteAccount.cancel")}
            </AlertDialogCancel>
            <AlertDialogAction
              className="rounded-2xl bg-destructive text-destructive-foreground hover:bg-destructive/90"
              onClick={handleDelete}
              disabled={!confirmMatches || loading}
            >
              {loading ? t("deleteAccount.deleting") : t("deleteAccount.deletePermanently")}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}
