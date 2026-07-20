"use client";

import { useState } from "react";
import { useTranslations } from "next-intl";
import { Loader2, Rss } from "lucide-react";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { useAiSettings, usePreviewRsshubFeed } from "@/hooks/use-rss-data";

type RsshubPreview = {
  route: string;
  url: string;
  title: string | null;
  itemCount: number;
  sampleTitles: string[];
};

interface RsshubPanelProps {
  onAddFeed: (url: string, title?: string) => void | Promise<void>;
  isAddingFeed: boolean;
}

function deriveNameFromPreview(preview: RsshubPreview): string {
  return preview.title?.trim() || preview.route;
}

export function RsshubPanel({ onAddFeed, isAddingFeed }: RsshubPanelProps) {
  const t = useTranslations("sidebar.rsshub");
  const [source, setSource] = useState("");
  const [preview, setPreview] = useState<RsshubPreview | null>(null);
  const [error, setError] = useState<string | null>(null);

  const { data: aiSettings } = useAiSettings();
  const aiConfigured = Boolean(aiSettings?.provider);
  const propose = usePreviewRsshubFeed();

  const looksLikeRoutePath = source.trim().startsWith("/");

  const handlePropose = async () => {
    const trimmed = source.trim();
    if (!trimmed) return;
    setError(null);
    setPreview(null);
    try {
      const result = await propose.mutateAsync(
        looksLikeRoutePath ? { routePath: trimmed } : { sourceDescription: trimmed },
      );
      if (!result.success) {
        setError(result.error || t("proposeFailed"));
        return;
      }
      setPreview({
        route: result.route,
        url: result.url,
        title: result.title,
        itemCount: result.itemCount,
        sampleTitles: result.sampleTitles,
      });
    } catch (err) {
      setError(err instanceof Error ? err.message : t("proposeFailed"));
    }
  };

  const handleAdd = async () => {
    if (!preview) return;
    await onAddFeed(preview.url, deriveNameFromPreview(preview));
    setSource("");
    setPreview(null);
    setError(null);
  };

  return (
    <div className="space-y-3">
      <p className="text-xs text-muted-foreground leading-relaxed">
        {aiConfigured ? t("introWithAi") : t("introManualOnly")}
      </p>
      <Input
        placeholder={t("sourcePlaceholder")}
        value={source}
        onChange={(e) => {
          setSource(e.target.value);
          setPreview(null);
          setError(null);
        }}
        onKeyDown={(e) => {
          if (e.key === "Enter" && source.trim()) handlePropose();
        }}
        className="h-9 text-sm w-full font-mono"
      />
      <Button
        size="sm"
        className="h-9 px-3 w-full"
        disabled={!source.trim() || propose.isPending}
        onClick={handlePropose}
      >
        {propose.isPending ? (
          <Loader2 className="w-4 h-4 animate-spin" />
        ) : looksLikeRoutePath ? (
          t("previewRoute")
        ) : (
          `✨ ${t("proposeButton")}`
        )}
      </Button>

      {error && !preview && (
        <div className="rounded-xl border border-amber-500/20 bg-amber-500/10 px-3 py-2 text-xs text-amber-700 dark:text-amber-300">
          {error}
        </div>
      )}

      {preview && (
        <div className="ui-control-surface space-y-2 rounded-xl border px-3 py-2">
          <p className="flex items-center gap-1.5 text-xs font-medium text-foreground">
            <Rss className="size-3.5 shrink-0 text-muted-foreground" />
            {preview.title || preview.route}
          </p>
          <p className="text-[11px] text-muted-foreground">{t("itemsFound", { count: preview.itemCount })}</p>
          {preview.sampleTitles.slice(0, 3).map((title, i) => (
            <p key={i} className="text-xs text-muted-foreground truncate">{title}</p>
          ))}
          <Button size="sm" className="w-full" disabled={isAddingFeed} onClick={handleAdd}>
            {isAddingFeed && <Loader2 className="w-4 h-4 animate-spin me-1.5" />}
            {t("addFeed")}
          </Button>
        </div>
      )}
    </div>
  );
}
