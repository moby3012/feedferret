"use client";

import { useTranslations } from "next-intl";
import { Copy, Shield, ShieldOff } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useTwoFactorStatus, useBeginTwoFactorSetup, useConfirmTwoFactorSetup, useDisableTwoFactor } from "@/hooks/use-rss-data";
import { useState, useCallback } from "react";
import { Input } from "@/components/ui/input";
import { toast } from "sonner";

export function TwoFactorSection() {
  const t = useTranslations();
  const { data: status } = useTwoFactorStatus();
  const beginSetup = useBeginTwoFactorSetup();
  const confirmSetup = useConfirmTwoFactorSetup();
  const disableTwoFactor = useDisableTwoFactor();
  const [setupData, setSetupData] = useState<{ secret: string; uri: string; issuer: string; accountName: string } | null>(null);
  const [setupCode, setSetupCode] = useState("");
  const [disableCode, setDisableCode] = useState("");

  const copyValue = useCallback(async (value: string, label: string) => {
    try {
      await navigator.clipboard.writeText(value);
      toast.success(t("twoFactor.copied", { label }));
    } catch {
      toast.error(t("twoFactor.couldNotCopy", { label: label.toLowerCase() }));
    }
  }, [t]);

  const handleBegin = async () => {
    try {
      const result = await beginSetup.mutateAsync();
      setSetupData(result);
      setSetupCode("");
    } catch {
      toast.error(t("twoFactor.beginSetupFailed"));
    }
  };

  const handleEnable = async () => {
    try {
      await confirmSetup.mutateAsync(setupCode);
      setSetupData(null);
      setSetupCode("");
    } catch {
      toast.error(t("twoFactor.enableFailed"));
    }
  };

  const handleDisable = async () => {
    try {
      await disableTwoFactor.mutateAsync(disableCode);
      setDisableCode("");
    } catch {
      toast.error(t("twoFactor.disableFailed"));
    }
  };

  return (
    <section className="rounded-2xl border border-border/65 bg-card/85 p-5 shadow-sm sm:p-6">
      <div className="flex flex-col gap-6">
        <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
          <div className="flex items-start gap-4">
            <div className="ui-brand-icon flex h-12 w-12 shrink-0 items-center justify-center rounded-2xl">
              <Shield className="h-5 w-5" />
            </div>
            <div>
              <h2 className="text-lg font-semibold tracking-title">{t("twoFactor.title")}</h2>
              <p className="mt-1 max-w-xl text-sm leading-6 text-muted-foreground">
                {t("twoFactor.description")}
              </p>
            </div>
          </div>
          {status?.enabled ? (
            <div className="inline-flex items-center gap-2 rounded-2xl border border-success/20 bg-success/10 px-4 py-2 text-sm font-medium text-success">
              <Shield className="h-4 w-4" /> {t("twoFactor.enabled")}
            </div>
          ) : (
            <Button
              type="button"
              onClick={handleBegin}
              disabled={beginSetup.isPending}
              className="h-11 rounded-2xl px-5"
            >
              {beginSetup.isPending ? t("twoFactor.starting") : t("twoFactor.beginSetup")}
            </Button>
          )}
        </div>

        {setupData && !status?.enabled && (
          <div className="ui-control-surface animate-fade-in-up grid gap-4 rounded-panel border p-4 sm:p-5">
            <div className="grid gap-2">
              <p className="text-sm font-medium">{t("twoFactor.addToAuthApp")}</p>
              <p className="text-xs text-muted-foreground">
                {t("twoFactor.manualSetupHint")}
              </p>
            </div>
            <div className="grid gap-3 sm:grid-cols-2">
              <div className="rounded-2xl border border-border/70 bg-background/70 p-3">
                <p className="text-xs uppercase tracking-wide text-muted-foreground">{t("twoFactor.account")}</p>
                <p className="mt-1 text-sm font-medium break-all">{setupData.accountName}</p>
              </div>
              <div className="rounded-2xl border border-border/70 bg-background/70 p-3">
                <p className="text-xs uppercase tracking-wide text-muted-foreground">{t("twoFactor.secret")}</p>
                <div className="mt-1 flex items-center gap-2">
                  <p className="text-sm font-medium break-all">{setupData.secret}</p>
                  <Button type="button" size="icon" variant="ghost" className="h-8 w-8 rounded-xl" onClick={() => copyValue(setupData.secret, t("twoFactor.secret"))}>
                    <Copy className="h-4 w-4" />
                  </Button>
                </div>
              </div>
            </div>
            <div className="rounded-2xl border border-border/70 bg-background/70 p-3">
              <div className="flex items-center justify-between gap-3">
                <div>
                  <p className="text-xs uppercase tracking-wide text-muted-foreground">{t("twoFactor.otpauthUri")}</p>
                  <p className="mt-1 text-xs text-muted-foreground break-all">{setupData.uri}</p>
                </div>
                <Button type="button" variant="outline" className="rounded-2xl" onClick={() => copyValue(setupData.uri, "URI")}>
                  <Copy className="me-2 h-4 w-4" /> {t("twoFactor.copy")}
                </Button>
              </div>
            </div>
            <div className="grid gap-3 sm:grid-cols-[1fr_auto] sm:items-end">
              <div className="space-y-2">
                <label className="text-sm font-medium" htmlFor="totp-setup-code">{t("twoFactor.enterCode")}</label>
                <Input
                  id="totp-setup-code"
                  inputMode="numeric"
                  pattern="[0-9]*"
                  placeholder="123456"
                  className="rounded-2xl border-border/70 bg-background/70"
                  value={setupCode}
                  onChange={(e) => setSetupCode(e.target.value.replace(/\D/g, "").slice(0, 6))}
                />
              </div>
              <div className="flex gap-2">
                <Button type="button" variant="outline" className="rounded-2xl" onClick={() => setSetupData(null)}>
                  {t("twoFactor.cancel")}
                </Button>
                <Button type="button" className="rounded-2xl" onClick={handleEnable} disabled={confirmSetup.isPending || setupCode.length !== 6}>
                  {confirmSetup.isPending ? t("twoFactor.enabling") : t("twoFactor.enableTwoFa")}
                </Button>
              </div>
            </div>
          </div>
        )}

        {status?.enabled && (
          <div className="ui-control-surface animate-fade-in-up grid gap-4 rounded-panel border p-4 sm:p-5">
            <div className="flex items-start gap-3 rounded-2xl border border-warning/20 bg-warning/10 p-3 text-sm text-warning">
              <ShieldOff className="mt-0.5 h-4 w-4 shrink-0" />
              <p>
                {t("twoFactor.greaderWarning")}
              </p>
            </div>
            <div className="grid gap-3 sm:grid-cols-[1fr_auto] sm:items-end">
              <div className="space-y-2">
                <label className="text-sm font-medium" htmlFor="totp-disable-code">{t("twoFactor.disableTwoFa")}</label>
                <Input
                  id="totp-disable-code"
                  inputMode="numeric"
                  pattern="[0-9]*"
                  placeholder="123456"
                  className="rounded-2xl border-border/70 bg-background/70"
                  value={disableCode}
                  onChange={(e) => setDisableCode(e.target.value.replace(/\D/g, "").slice(0, 6))}
                />
              </div>
              <Button
                type="button"
                variant="outline"
                className="rounded-2xl border-destructive/30 text-destructive hover:bg-destructive/10"
                onClick={handleDisable}
                disabled={disableTwoFactor.isPending || disableCode.length !== 6}
              >
                {disableTwoFactor.isPending ? t("twoFactor.disabling") : t("twoFactor.disableTwoFa")}
              </Button>
            </div>
          </div>
        )}
      </div>
    </section>
  );
}
