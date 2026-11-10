"use client";

import { useTranslations, useFormatter } from "next-intl";
import { Sparkles, CheckCircle2, XCircle } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { cn } from "@/lib/utils";
import { useAiSettings, useUpdateAiSettings, useTestAiConnection } from "@/hooks/use-rss-data";
import { useState, useEffect } from "react";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";

export function AiSummarySection() {
  const t = useTranslations();
  const format = useFormatter();
  const { data: ai } = useAiSettings();
  const updateAi = useUpdateAiSettings();
  const testAi = useTestAiConnection();
  const [provider, setProvider] = useState<string>("none");
  const [apiKey, setApiKey] = useState("");
  const [model, setModel] = useState("");
  const [ollamaBaseUrl, setOllamaBaseUrl] = useState("");
  const [language, setLanguage] = useState("same");
  const [autoSummarize, setAutoSummarize] = useState(false);
  const [autoTag, setAutoTag] = useState(false);
  const [cleanTitles, setCleanTitles] = useState(false);
  const [briefingAuto, setBriefingAuto] = useState(true);
  const [dailyCap, setDailyCap] = useState("");
  const [testResult, setTestResult] = useState<{ success: boolean; error?: string } | null>(null);

  useEffect(() => {
    if (!ai) return;
    setProvider(ai.provider ?? "none");
    setModel(ai.model ?? "");
    setOllamaBaseUrl(ai.ollamaBaseUrl ?? "");
    setLanguage(ai.language ?? "same");
    setAutoSummarize(ai.autoSummarize ?? false);
    setAutoTag(ai.autoTag ?? false);
    setCleanTitles(ai.cleanTitles ?? false);
    setBriefingAuto(ai.briefingAuto ?? true);
    setDailyCap(ai.dailyCap === null || ai.dailyCap === undefined ? "" : String(ai.dailyCap));
  }, [ai]);

  const handleSave = () => {
    setTestResult(null);
    updateAi.mutate({
      provider: provider === "none" ? null : provider,
      ...(apiKey ? { apiKey } : {}),
      model: model || null,
      ollamaBaseUrl: ollamaBaseUrl || null,
      autoSummarize,
      language,
      autoTag,
      cleanTitles,
      briefingAuto,
      dailyCap: dailyCap.trim() === "" ? null : dailyCap.trim(),
    });
  };

  const handleTest = async () => {
    setTestResult(null);
    // Test the form's current values, not just what's already saved — so
    // "Test connection" reflects a provider/key the user just typed instead
    // of silently testing stale settings until they click "Save" first.
    const result = await testAi.mutateAsync({
      provider: provider === "none" ? null : provider,
      ...(apiKey ? { apiKey } : {}),
      model: model || null,
      ollamaBaseUrl: ollamaBaseUrl || null,
    });
    setTestResult(result);
  };

  return (
    <section className="rounded-panel border border-border/65 bg-card/85 p-5 sm:p-6">
      <div className="flex items-start gap-4 mb-6">
        <div className="ui-brand-icon flex h-12 w-12 shrink-0 items-center justify-center rounded-panel">
          <Sparkles className="h-5 w-5" />
        </div>
        <div>
          <h2 className="text-title-sm font-semibold tracking-title">{t("ai.title")}</h2>
          <p className="mt-1 text-body-sm leading-6 text-muted-foreground">
            {t("ai.description")}
          </p>
        </div>
      </div>

      <div className="space-y-4">
        {/* Provider */}
        <div className="grid gap-1.5">
          <label className="text-body-sm font-medium" htmlFor="ai-provider-select">{t("ai.provider")}</label>
          <Select value={provider} onValueChange={setProvider}>
            <SelectTrigger id="ai-provider-select" className="h-10 rounded-panel">
              <SelectValue placeholder={t("ai.provider")} />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="none">{t("ai.providers.none")}</SelectItem>
              <SelectItem value="openai">{t("ai.providers.openai")}</SelectItem>
              <SelectItem value="anthropic">{t("ai.providers.anthropic")}</SelectItem>
              <SelectItem value="gemini">{t("ai.providers.gemini")}</SelectItem>
              <SelectItem value="openrouter">{t("ai.providers.openrouter")}</SelectItem>
              <SelectItem value="ollama">{t("ai.providers.ollama")}</SelectItem>
              {ai?.fakeProviderAvailable && <SelectItem value="fake">Fake (CI)</SelectItem>}
            </SelectContent>
          </Select>
        </div>

        {provider !== "none" && provider !== "ollama" && (
          <div className="rounded-panel border border-warning/30 bg-warning/10 px-4 py-3 text-body-sm text-warning">
            {t("ai.privacyWarning")}
          </div>
        )}

        {provider !== "none" && provider !== "ollama" && (
          <div className="grid gap-1.5">
            <label className="text-body-sm font-medium" htmlFor="ai-api-key-input">
              {t("ai.apiKey")}
              {ai?.hasApiKey && !apiKey && (
                <span className="ms-2 text-footnote font-normal text-muted-foreground">({t("ai.currentlySet")})</span>
              )}
            </label>
            <Input
              id="ai-api-key-input"
              type="password"
              placeholder={ai?.hasApiKey ? t("ai.leaveBlankToKeep") : "sk-..."}
              value={apiKey}
              onChange={(e) => setApiKey(e.target.value)}
              className="h-10 rounded-panel font-mono text-body-sm"
            />
          </div>
        )}

        {provider === "ollama" && (
          <div className="grid gap-1.5">
            <label className="text-body-sm font-medium" htmlFor="ai-ollama-base-url-input">{t("ai.ollamaBaseUrl")}</label>
            <Input
              id="ai-ollama-base-url-input"
              placeholder="http://localhost:11434"
              value={ollamaBaseUrl}
              onChange={(e) => setOllamaBaseUrl(e.target.value)}
              className="h-10 rounded-panel font-mono text-body-sm"
            />
          </div>
        )}

        {provider !== "none" && (
          <div className="grid gap-1.5">
            <label className="text-body-sm font-medium" htmlFor="ai-model-input">
              {t("ai.model")}
              <span className="ms-1 text-footnote font-normal text-muted-foreground">
                {provider === "openai" && "(default: gpt-4o-mini)"}
                {provider === "anthropic" && "(default: claude-haiku-4-5-20251001)"}
                {provider === "gemini" && "(default: gemini-1.5-flash)"}
                {provider === "openrouter" && "(default: openai/gpt-4o-mini)"}
                {provider === "ollama" && "(default: llama3)"}
              </span>
            </label>
            <Input
              id="ai-model-input"
              placeholder="optional override"
              value={model}
              onChange={(e) => setModel(e.target.value)}
              className="h-10 rounded-panel font-mono text-body-sm"
            />
          </div>
        )}

        {provider !== "none" && (
          <div className="grid gap-1.5">
            <label className="text-body-sm font-medium" htmlFor="ai-language-select">{t("ai.summaryLanguage")}</label>
            <Select value={language} onValueChange={setLanguage}>
              <SelectTrigger id="ai-language-select" className="h-10 rounded-panel">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="same">{t("ai.languages.same")}</SelectItem>
                <SelectItem value="English">{t("ai.languages.english")}</SelectItem>
                <SelectItem value="German">{t("ai.languages.german")}</SelectItem>
                <SelectItem value="French">{t("ai.languages.french")}</SelectItem>
                <SelectItem value="Spanish">{t("ai.languages.spanish")}</SelectItem>
                <SelectItem value="Japanese">{t("ai.languages.japanese")}</SelectItem>
                <SelectItem value="Chinese">{t("ai.languages.chinese")}</SelectItem>
              </SelectContent>
            </Select>
          </div>
        )}

        {provider !== "none" && (
          <div className="ui-control-surface flex items-center justify-between rounded-panel border px-4 py-3">
            <div>
              <p className="text-body-sm font-medium">{t("ai.autoSummarize")}</p>
              <p className="text-footnote text-muted-foreground">{t("ai.autoSummarizeDescription")}</p>
            </div>
            <Switch
              checked={autoSummarize}
              onCheckedChange={setAutoSummarize}
            />
          </div>
        )}

        {provider !== "none" && (
          <div className="ui-control-surface flex items-center justify-between rounded-panel border px-4 py-3">
            <div>
              <p className="text-body-sm font-medium">{t("ai.autoTag")}</p>
              <p className="text-footnote text-muted-foreground">{t("ai.autoTagDescription")}</p>
            </div>
            <Switch
              checked={autoTag}
              onCheckedChange={setAutoTag}
            />
          </div>
        )}

        {provider !== "none" && (
          <div className="ui-control-surface flex items-center justify-between rounded-panel border px-4 py-3">
            <div>
              <p className="text-body-sm font-medium">{t("ai.cleanTitles")}</p>
              <p className="text-footnote text-muted-foreground">{t("ai.cleanTitlesDescription")}</p>
            </div>
            <Switch checked={cleanTitles} onCheckedChange={setCleanTitles} />
          </div>
        )}

        {provider !== "none" && (
          <div className="ui-control-surface flex items-center justify-between gap-4 rounded-panel border px-4 py-3">
            <div>
              <p className="text-body-sm font-medium" id="ai-briefing-auto-label">{t("ai.briefingAuto")}</p>
              <p className="text-footnote text-muted-foreground">{t("ai.briefingAutoDescription")}</p>
              <p className="mt-1 text-footnote text-muted-foreground">{t("ai.briefingPrivacy")}</p>
            </div>
            <Switch checked={briefingAuto} onCheckedChange={setBriefingAuto} aria-labelledby="ai-briefing-auto-label" />
          </div>
        )}

        {provider !== "none" && (
          <div className="grid gap-1.5">
            <label className="text-body-sm font-medium" htmlFor="ai-daily-cap-input">{t("ai.dailyCap")}</label>
            <Input
              id="ai-daily-cap-input"
              type="number"
              inputMode="numeric"
              min={0}
              step={1000}
              value={dailyCap}
              placeholder={String(ai?.defaultDailyCap ?? 150000)}
              onChange={(e) => setDailyCap(e.target.value)}
              className="h-10 rounded-panel"
              aria-describedby="ai-daily-cap-hint"
            />
            <p id="ai-daily-cap-hint" className="text-footnote text-muted-foreground">
              {t("ai.dailyCapDescription", { default: (ai?.defaultDailyCap ?? 150000).toLocaleString() })}{" "}
              {t("ai.dailyCapDay", { time: ai?.budgetResetsAt ? format.dateTime(new Date(ai.budgetResetsAt), { hour: "2-digit", minute: "2-digit" }) : "00:00 UTC" })}
            </p>
            <p className="text-footnote text-muted-foreground" data-testid="ai-usage-today">
              {t("ai.usageTodayCloud", { count: (ai?.usedToday ?? 0).toLocaleString() })}
              {(ai?.localUsedToday ?? 0) > 0 && <> · {t("ai.usageTodayLocal", { count: (ai?.localUsedToday ?? 0).toLocaleString() })}</>}
            </p>
            {ai?.budgetPaused && (
              <p role="status" className="rounded-panel border border-warning/30 bg-warning/10 px-3 py-2 text-footnote text-foreground" data-testid="ai-budget-paused">
                {t("ai.budgetPaused", { time: format.dateTime(new Date(ai.budgetResetsAt), { weekday: "short", hour: "2-digit", minute: "2-digit" }) })}
              </p>
            )}
          </div>
        )}

        {testResult && (
          <div className={cn(
            "flex items-center gap-2 rounded-panel border px-4 py-3 text-body-sm",
            testResult.success
              ? "border-success/30 bg-success/10 text-success"
              : "border-destructive/30 bg-destructive/10 text-destructive"
          )}>
            {testResult.success
              ? <CheckCircle2 className="h-4 w-4 shrink-0" />
              : <XCircle className="h-4 w-4 shrink-0" />}
            <span>{testResult.success ? t("ai.connectionSuccessful") : testResult.error}</span>
          </div>
        )}

        <div className="flex gap-2 pt-1">
          <Button
            onClick={handleSave}
            disabled={updateAi.isPending}
            className="rounded-panel h-10"
          >
            {updateAi.isPending ? t("ai.saving") : t("ai.save")}
          </Button>
          {provider !== "none" && (
            <Button
              variant="outline"
              onClick={handleTest}
              disabled={testAi.isPending}
              className="rounded-panel h-10"
            >
              <Sparkles className="w-4 h-4 me-2" />
              {testAi.isPending ? t("ai.testing") : t("ai.testConnection")}
            </Button>
          )}
        </div>
      </div>
    </section>
  );
}
