"use client";

import { useState } from "react";
import { useTranslations } from "next-intl";
import { Loader2, FileSearch } from "lucide-react";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { ScrollArea } from "@/components/ui/scroll-area";
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";
import { cn } from "@/lib/utils";
import { useSuggestFeedFromUrl, useCreateFeedFromPage } from "@/hooks/use-rss-data";
import { toast } from "sonner";
import type { SuggestedFieldConfig } from "@/lib/page-feed-suggest";

type PreviewItem = { title: string; link: string; publishedAt: string | null; imageUrl: string | null };
type PageFeedCandidate = {
  config: SuggestedFieldConfig;
  score: number;
  itemCount: number;
  sampleTitles: string[];
  preview: PreviewItem[];
};

interface PageFeedPanelProps {
  categoryId?: string;
  onCreated: (feed: { name: string }) => void;
}

function hostOf(link: string): string {
  try {
    return new URL(link).hostname.replace(/^www\./, "");
  } catch {
    return link;
  }
}

function deriveNameFromUrl(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return "";
  }
}

export function PageFeedPanel({ categoryId, onCreated }: PageFeedPanelProps) {
  const t = useTranslations("sidebar.webpage");
  const [url, setUrl] = useState("");
  const [candidates, setCandidates] = useState<PageFeedCandidate[] | null>(null);
  const [selectedIndex, setSelectedIndex] = useState(0);
  const [name, setName] = useState("");
  const [suggestError, setSuggestError] = useState<string | null>(null);

  const suggest = useSuggestFeedFromUrl();
  const create = useCreateFeedFromPage();

  const handleFindItems = async () => {
    const trimmedUrl = url.trim();
    if (!trimmedUrl) return;
    setSuggestError(null);
    setCandidates(null);
    try {
      const result = await suggest.mutateAsync(trimmedUrl);
      if (!result.success) {
        const message = result.error || t("suggestFailed");
        setSuggestError(message);
        toast.error(message);
        return;
      }
      setCandidates(result.candidates as PageFeedCandidate[]);
      setSelectedIndex(0);
      setName(deriveNameFromUrl(trimmedUrl));
    } catch (err) {
      const message = err instanceof Error ? err.message : t("suggestFailed");
      setSuggestError(message);
      toast.error(message);
    }
  };

  const handleCreate = async () => {
    const selected = candidates?.[selectedIndex];
    if (!selected) return;
    try {
      const result = await create.mutateAsync({
        url: url.trim(),
        config: selected.config,
        name: name.trim() || undefined,
        categoryId: categoryId && categoryId !== "none" ? categoryId : undefined,
      });
      if (!result.success || !result.feed) {
        toast.error(result.error || t("createFailed"));
        return;
      }
      onCreated(result.feed);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : t("createFailed"));
    }
  };

  return (
    <div className="space-y-3">
      <div className="flex gap-1.5">
        <Input
          placeholder={t("urlPlaceholder")}
          value={url}
          onChange={(e) => {
            setUrl(e.target.value);
            setCandidates(null);
            setSuggestError(null);
          }}
          onKeyDown={(e) => {
            if (e.key === "Enter" && url.trim()) handleFindItems();
          }}
          className="h-9 text-sm flex-1"
        />
        <Button
          size="sm"
          className="h-9 px-3 shrink-0"
          disabled={!url.trim() || suggest.isPending}
          onClick={handleFindItems}
        >
          {suggest.isPending ? <Loader2 className="w-4 h-4 animate-spin" /> : t("findItems")}
        </Button>
      </div>

      {suggestError && !candidates && (
        <div className="rounded-xl border border-amber-500/20 bg-amber-500/10 px-3 py-2 text-xs text-amber-700 dark:text-amber-300">
          {suggestError}
        </div>
      )}

      {candidates && candidates.length === 0 && (
        <div className="flex flex-col items-center justify-center py-8 text-center">
          <FileSearch className="size-5 text-muted-foreground/50 mb-2" />
          <p className="text-sm text-muted-foreground">{t("emptyTitle")}</p>
          <p className="text-xs text-muted-foreground mt-1">{t("emptyHint")}</p>
        </div>
      )}

      {candidates && candidates.length > 0 && (
        <>
          <ScrollArea className="h-[220px]">
            <RadioGroup
              value={String(selectedIndex)}
              onValueChange={(v) => setSelectedIndex(Number(v))}
              className="gap-2 pe-2"
            >
              {candidates.map((candidate, i) => (
                <label
                  key={i}
                  htmlFor={`page-feed-candidate-${i}`}
                  className={cn(
                    "ui-control-surface flex items-start gap-2 rounded-xl border px-3 py-2 cursor-pointer",
                    selectedIndex === i && "border-primary ring-1 ring-primary/40",
                  )}
                >
                  <RadioGroupItem value={String(i)} id={`page-feed-candidate-${i}`} className="mt-0.5 shrink-0" />
                  <div className="min-w-0 flex-1 space-y-1">
                    <p className="text-xs font-medium text-foreground">
                      {t("itemsFound", { count: candidate.itemCount })}
                    </p>
                    {candidate.sampleTitles.slice(0, 3).map((title, ti) => (
                      <p key={ti} className="text-xs text-muted-foreground truncate">{title}</p>
                    ))}
                    {candidate.preview.length > 0 && (
                      <div className="flex flex-wrap gap-1 pt-0.5">
                        {candidate.preview.slice(0, 3).map((item, pi) => (
                          <span
                            key={pi}
                            className="rounded-lg bg-muted px-1.5 py-0.5 text-[10px] text-muted-foreground truncate max-w-[140px]"
                            title={item.title}
                          >
                            {item.title} · {hostOf(item.link)}
                          </span>
                        ))}
                      </div>
                    )}
                  </div>
                </label>
              ))}
            </RadioGroup>
          </ScrollArea>

          <Input
            placeholder={t("namePlaceholder")}
            value={name}
            onChange={(e) => setName(e.target.value)}
            className="h-9 text-sm"
          />

          <Button
            size="sm"
            className="w-full"
            disabled={create.isPending}
            onClick={handleCreate}
          >
            {create.isPending && <Loader2 className="w-4 h-4 animate-spin me-1.5" />}
            {t("createFeed")}
          </Button>
        </>
      )}
    </div>
  );
}
