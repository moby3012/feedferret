"use client";

import { useTranslations } from "next-intl";
import { CheckCircle2, XCircle, Cloud } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { cn } from "@/lib/utils";
import { useContentFetchSettings, useUpdateContentFetchSettings, useTestContentFetchConnection } from "@/hooks/use-rss-data";
import { useState, useEffect } from "react";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import { AiSummarySection } from "@/components/settings/sections/ai-summary";

export function ContentFetchSection() {
  const t = useTranslations();
  const { data: contentFetch } = useContentFetchSettings();
  const updateContentFetch = useUpdateContentFetchSettings();
  const testContentFetch = useTestContentFetchConnection();
  const [provider, setProvider] = useState<string>("none");
  const [apiKey, setApiKey] = useState("");
  const [autoUse, setAutoUse] = useState(false);
  const [testResult, setTestResult] = useState<{ success: boolean; error?: string; rateLimited?: boolean } | null>(null);

  useEffect(() => {
    if (!contentFetch) return;
    setProvider(contentFetch.provider ?? "none");
    setAutoUse(contentFetch.autoUse ?? false);
  }, [contentFetch]);

  const handleSave = () => {
    setTestResult(null);
    updateContentFetch.mutate({
      provider: provider === "none" ? null : provider,
      ...(apiKey ? { apiKey } : {}),
      autoUse,
    });
  };

  const handleTest = async () => {
    setTestResult(null);
    // Test the form's current values, not just what's already saved — see
    // the equivalent comment in AiSummarySection's handleTest.
    const result = await testContentFetch.mutateAsync({
      provider: provider === "none" ? null : provider,
      ...(apiKey ? { apiKey } : {}),
    });
    setTestResult(result);
  };

  return (
    <section className="rounded-panel border border-border/65 bg-card/85 p-5 sm:p-6">
      <div className="flex items-start gap-4 mb-6">
        <div className="ui-brand-icon flex h-12 w-12 shrink-0 items-center justify-center rounded-panel">
          <Cloud className="h-5 w-5" />
        </div>
        <div>
          <h2 className="text-title-sm font-semibold tracking-title">{t("contentFetch.title")}</h2>
          <p className="mt-1 text-body-sm leading-6 text-muted-foreground">
            {t("contentFetch.description")}
          </p>
        </div>
      </div>

      <div className="space-y-4">
        {/* Provider */}
        <div className="grid gap-1.5">
          <label className="text-body-sm font-medium" htmlFor="content-fetch-provider-select">{t("contentFetch.provider")}</label>
          <Select value={provider} onValueChange={setProvider}>
            <SelectTrigger id="content-fetch-provider-select" className="h-10 rounded-panel">
              <SelectValue placeholder={t("contentFetch.provider")} />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="none">{t("contentFetch.providers.none")}</SelectItem>
              <SelectItem value="jina">{t("contentFetch.providers.jina")}</SelectItem>
              <SelectItem value="firecrawl">{t("contentFetch.providers.firecrawl")}</SelectItem>
            </SelectContent>
          </Select>
        </div>

        {provider !== "none" && (
          <>
            <div className="rounded-panel border border-warning/30 bg-warning/10 px-4 py-3 text-body-sm text-warning">
              {t("contentFetch.privacyWarning")}
            </div>

            <div className="grid gap-1.5">
              <label className="text-body-sm font-medium" htmlFor="content-fetch-api-key-input">
                {t("contentFetch.apiKey")}
                {provider === "firecrawl" && (
                  <span className="ms-2 text-footnote font-normal text-muted-foreground">({t("contentFetch.optional")})</span>
                )}
                {contentFetch?.hasApiKey && !apiKey && (
                  <span className="ms-2 text-footnote font-normal text-muted-foreground">({t("ai.currentlySet")})</span>
                )}
              </label>
              <Input
                id="content-fetch-api-key-input"
                type="password"
                placeholder={contentFetch?.hasApiKey ? t("ai.leaveBlankToKeep") : "jina_... / fc-..."}
                value={apiKey}
                onChange={(e) => setApiKey(e.target.value)}
                className="h-10 rounded-panel font-mono text-body-sm"
              />
              {provider === "firecrawl" && !apiKey && !contentFetch?.hasApiKey && (
                <p className="text-footnote text-muted-foreground">{t("contentFetch.firecrawlKeylessHint")}</p>
              )}
            </div>

            <div className="ui-control-surface flex items-center justify-between rounded-panel border px-4 py-3">
              <div>
                <p className="text-body-sm font-medium">{t("contentFetch.autoUse")}</p>
                <p className="text-footnote text-muted-foreground">{t("contentFetch.autoUseDescription")}</p>
              </div>
              <Switch checked={autoUse} onCheckedChange={setAutoUse} />
            </div>
          </>
        )}

        {testResult && (
          <div className={cn(
            "flex items-center gap-2 rounded-panel border px-4 py-3 text-body-sm",
            testResult.success
              ? "border-success/30 bg-success/10 text-success"
              : testResult.rateLimited
              ? "border-warning/30 bg-warning/10 text-warning"
              : "border-destructive/30 bg-destructive/10 text-destructive"
          )}>
            {testResult.success
              ? <CheckCircle2 className="h-4 w-4 shrink-0" />
              : <XCircle className="h-4 w-4 shrink-0" />}
            <span>{testResult.success ? t("contentFetch.connectionSuccessful") : testResult.error}</span>
          </div>
        )}

        <div className="flex gap-2 pt-1">
          <Button
            onClick={handleSave}
            disabled={updateContentFetch.isPending}
            className="rounded-panel h-10"
          >
            {updateContentFetch.isPending ? t("ai.saving") : t("ai.save")}
          </Button>
          {provider !== "none" && (
            <Button
              variant="outline"
              onClick={handleTest}
              disabled={testContentFetch.isPending}
              className="rounded-panel h-10"
            >
              <Cloud className="w-4 h-4 me-2" />
              {testContentFetch.isPending ? t("ai.testing") : t("ai.testConnection")}
            </Button>
          )}
        </div>
      </div>
    </section>
  );
}
