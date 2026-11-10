"use client";

import { useTranslations } from "next-intl";
import { Send, CheckCircle2, XCircle } from "lucide-react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { useExportSettings, useUpdateExportSettings, useTestWallabagExportConnection } from "@/hooks/use-rss-data";
import { useState, useEffect } from "react";
import { Input } from "@/components/ui/input";
import { AiSummarySection } from "@/components/settings/sections/ai-summary";
import { ContentFetchSection } from "@/components/settings/sections/content-fetch";

export function ExportDestinationsSection() {
  const t = useTranslations("exportDestinations");
  const { data: exportSettings } = useExportSettings();
  const updateExport = useUpdateExportSettings();
  const testWallabag = useTestWallabagExportConnection();

  const [obsidianVault, setObsidianVault] = useState("");
  const [wallabagUrl, setWallabagUrl] = useState("");
  const [wallabagClientId, setWallabagClientId] = useState("");
  const [wallabagClientSecret, setWallabagClientSecret] = useState("");
  const [wallabagUsername, setWallabagUsername] = useState("");
  const [wallabagPassword, setWallabagPassword] = useState("");
  const [wallabagTestResult, setWallabagTestResult] = useState<{ success: boolean; error?: string } | null>(null);

  useEffect(() => {
    if (!exportSettings) return;
    setObsidianVault(exportSettings.obsidianVault ?? "");
    setWallabagUrl(exportSettings.wallabagUrl ?? "");
    setWallabagClientId(exportSettings.wallabagClientId ?? "");
    setWallabagUsername(exportSettings.wallabagUsername ?? "");
  }, [exportSettings]);

  const handleSaveObsidian = () => {
    updateExport.mutate({ obsidianVault: obsidianVault.trim() || null });
  };

  const handleSaveWallabag = () => {
    setWallabagTestResult(null);
    updateExport.mutate({
      wallabagUrl: wallabagUrl.trim() || null,
      wallabagClientId: wallabagClientId.trim() || null,
      wallabagUsername: wallabagUsername.trim() || null,
      ...(wallabagClientSecret ? { wallabagClientSecret } : {}),
      ...(wallabagPassword ? { wallabagPassword } : {}),
    });
  };

  const handleTestWallabag = async () => {
    setWallabagTestResult(null);
    // Test the form's current (possibly unsaved) values — see the equivalent
    // comment in AiSummarySection/ContentFetchSection's handleTest.
    const result = await testWallabag.mutateAsync({
      wallabagUrl: wallabagUrl.trim(),
      wallabagClientId: wallabagClientId.trim(),
      wallabagUsername: wallabagUsername.trim(),
      ...(wallabagClientSecret ? { wallabagClientSecret } : {}),
      ...(wallabagPassword ? { wallabagPassword } : {}),
    });
    setWallabagTestResult(result);
  };

  return (
    <section className="rounded-2xl border border-border/65 bg-card/85 p-5 shadow-sm sm:p-6">
      <div className="flex items-start gap-4 mb-6">
        <div className="ui-brand-icon flex h-12 w-12 shrink-0 items-center justify-center rounded-2xl">
          <Send className="h-5 w-5" />
        </div>
        <div>
          <h2 className="text-lg font-semibold tracking-title">{t("title")}</h2>
          <p className="mt-1 text-sm leading-6 text-muted-foreground">{t("description")}</p>
        </div>
      </div>

      <div className="space-y-6">
        {/* Obsidian */}
        <div className="space-y-3 rounded-2xl border border-border/60 p-4">
          <div>
            <h3 className="text-sm font-semibold">{t("obsidianTitle")}</h3>
            <p className="mt-0.5 text-xs text-muted-foreground">{t("obsidianDescription")}</p>
          </div>
          <div className="grid gap-1.5">
            <label className="text-sm font-medium" htmlFor="export-obsidian-vault-input">{t("obsidianVaultLabel")}</label>
            <Input
              id="export-obsidian-vault-input"
              placeholder={t("obsidianVaultPlaceholder")}
              value={obsidianVault}
              onChange={(e) => setObsidianVault(e.target.value)}
              className="h-10 rounded-2xl"
            />
          </div>
          <Button
            onClick={handleSaveObsidian}
            disabled={updateExport.isPending}
            size="sm"
            className="rounded-2xl h-9"
          >
            {updateExport.isPending ? t("saving") : t("save")}
          </Button>
        </div>

        {/* Wallabag */}
        <div className="space-y-3 rounded-2xl border border-border/60 p-4">
          <div>
            <h3 className="text-sm font-semibold">{t("wallabagTitle")}</h3>
            <p className="mt-0.5 text-xs text-muted-foreground">{t("wallabagDescription")}</p>
          </div>

          <div className="grid gap-1.5">
            <label className="text-sm font-medium" htmlFor="export-wallabag-url-input">{t("wallabagUrlLabel")}</label>
            <Input
              id="export-wallabag-url-input"
              placeholder={t("wallabagUrlPlaceholder")}
              value={wallabagUrl}
              onChange={(e) => setWallabagUrl(e.target.value)}
              className="h-10 rounded-2xl"
            />
          </div>

          <div className="grid gap-3 sm:grid-cols-2">
            <div className="grid gap-1.5">
              <label className="text-sm font-medium" htmlFor="export-wallabag-client-id-input">{t("wallabagClientIdLabel")}</label>
              <Input
                id="export-wallabag-client-id-input"
                value={wallabagClientId}
                onChange={(e) => setWallabagClientId(e.target.value)}
                className="h-10 rounded-2xl font-mono text-sm"
              />
            </div>
            <div className="grid gap-1.5">
              <label className="text-sm font-medium" htmlFor="export-wallabag-client-secret-input">
                {t("wallabagClientSecretLabel")}
                {exportSettings?.hasWallabagClientSecret && !wallabagClientSecret && (
                  <span className="ms-2 text-xs font-normal text-muted-foreground">({t("currentlySet")})</span>
                )}
              </label>
              <Input
                id="export-wallabag-client-secret-input"
                type="password"
                placeholder={exportSettings?.hasWallabagClientSecret ? t("leaveBlankToKeep") : undefined}
                value={wallabagClientSecret}
                onChange={(e) => setWallabagClientSecret(e.target.value)}
                className="h-10 rounded-2xl font-mono text-sm"
              />
            </div>
            <div className="grid gap-1.5">
              <label className="text-sm font-medium" htmlFor="export-wallabag-username-input">{t("wallabagUsernameLabel")}</label>
              <Input
                id="export-wallabag-username-input"
                value={wallabagUsername}
                onChange={(e) => setWallabagUsername(e.target.value)}
                className="h-10 rounded-2xl"
              />
            </div>
            <div className="grid gap-1.5">
              <label className="text-sm font-medium" htmlFor="export-wallabag-password-input">
                {t("wallabagPasswordLabel")}
                {exportSettings?.hasWallabagPassword && !wallabagPassword && (
                  <span className="ms-2 text-xs font-normal text-muted-foreground">({t("currentlySet")})</span>
                )}
              </label>
              <Input
                id="export-wallabag-password-input"
                type="password"
                placeholder={exportSettings?.hasWallabagPassword ? t("leaveBlankToKeep") : undefined}
                value={wallabagPassword}
                onChange={(e) => setWallabagPassword(e.target.value)}
                className="h-10 rounded-2xl"
              />
            </div>
          </div>

          {wallabagTestResult && (
            <div className={cn(
              "flex items-center gap-2 rounded-2xl border px-4 py-3 text-sm",
              wallabagTestResult.success
                ? "border-success/30 bg-success/10 text-success"
                : "border-destructive/30 bg-destructive/10 text-destructive"
            )}>
              {wallabagTestResult.success
                ? <CheckCircle2 className="h-4 w-4 shrink-0" />
                : <XCircle className="h-4 w-4 shrink-0" />}
              <span>{wallabagTestResult.success ? t("connectionSuccessful") : wallabagTestResult.error}</span>
            </div>
          )}

          <div className="flex gap-2 pt-1">
            <Button
              onClick={handleSaveWallabag}
              disabled={updateExport.isPending}
              size="sm"
              className="rounded-2xl h-9"
            >
              {updateExport.isPending ? t("saving") : t("save")}
            </Button>
            <Button
              variant="outline"
              onClick={handleTestWallabag}
              disabled={testWallabag.isPending}
              size="sm"
              className="rounded-2xl h-9"
            >
              {testWallabag.isPending ? t("testing") : t("testConnection")}
            </Button>
          </div>
        </div>
      </div>
    </section>
  );
}
