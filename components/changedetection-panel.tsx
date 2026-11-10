"use client";

import { useState } from "react";
import { useTranslations } from "next-intl";
import { Loader2, Eye } from "lucide-react";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { useAiSettings, useCreateChangedetectionFeed } from "@/hooks/use-rss-data";

interface ChangedetectionPanelProps {
  onAddFeed: (url: string, title?: string) => void | Promise<void>;
  isAddingFeed: boolean;
}

export function ChangedetectionPanel({ onAddFeed, isAddingFeed }: ChangedetectionPanelProps) {
  const t = useTranslations("sidebar.changedetection");
  const [url, setUrl] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [created, setCreated] = useState<{ url: string; usedAiSelector: boolean } | null>(null);

  const { data: aiSettings } = useAiSettings();
  const aiConfigured = Boolean(aiSettings?.provider);
  const create = useCreateChangedetectionFeed();

  const handleCreate = async () => {
    const trimmed = url.trim();
    if (!trimmed) return;
    setError(null);
    setCreated(null);
    try {
      const result = await create.mutateAsync({ url: trimmed, useAiSelector: aiConfigured });
      if (!result.success) {
        setError(result.error || t("createFailed"));
        return;
      }
      setCreated({ url: result.url, usedAiSelector: result.usedAiSelector });
    } catch (err) {
      setError(err instanceof Error ? err.message : t("createFailed"));
    }
  };

  const handleAdd = async () => {
    if (!created) return;
    await onAddFeed(created.url, url.trim());
    setUrl("");
    setCreated(null);
    setError(null);
  };

  return (
    <div className="space-y-3">
      <p className="text-footnote text-muted-foreground leading-relaxed">{t("intro")}</p>
      <Input
        placeholder={t("urlPlaceholder")}
        value={url}
        onChange={(e) => {
          setUrl(e.target.value);
          setCreated(null);
          setError(null);
        }}
        onKeyDown={(e) => {
          if (e.key === "Enter" && url.trim()) handleCreate();
        }}
        className="h-9 text-body-sm w-full"
      />
      <Button size="sm" className="h-9 px-3 w-full" disabled={!url.trim() || create.isPending} onClick={handleCreate}>
        {create.isPending ? <Loader2 className="w-4 h-4 animate-spin" /> : t("monitorButton")}
      </Button>

      {error && !created && (
        <div className="rounded-panel border border-warning/20 bg-warning/10 px-3 py-2 text-footnote text-warning">
          {error}
        </div>
      )}

      {created && (
        <div className="ui-control-surface space-y-2 rounded-panel border px-3 py-2">
          <p className="flex items-center gap-1.5 text-footnote font-medium text-foreground">
            <Eye className="size-3.5 shrink-0 text-muted-foreground" />
            {t("watchCreated")}
          </p>
          <p className="text-caption text-muted-foreground leading-relaxed">
            {created.usedAiSelector ? t("watchCreatedHintAi") : t("watchCreatedHint")}
          </p>
          <Button size="sm" className="w-full" disabled={isAddingFeed} onClick={handleAdd}>
            {isAddingFeed && <Loader2 className="w-4 h-4 animate-spin me-1.5" />}
            {t("addFeed")}
          </Button>
        </div>
      )}
    </div>
  );
}
