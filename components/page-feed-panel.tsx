"use client";

import { useEffect, useState } from "react";
import { useFormatter, useTranslations } from "next-intl";
import { Loader2, FileSearch, CircleAlert, CircleCheck } from "lucide-react";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { ScrollArea } from "@/components/ui/scroll-area";
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";
import { cn } from "@/lib/utils";
import { useSuggestFeedFromUrl, useCreateFeedFromPage, useProposeAiFeedConfig, useAiSettings } from "@/hooks/use-rss-data";
import { toast } from "sonner";
import type { CandidateQuality, SuggestedFieldConfig } from "@/lib/page-feed-suggest";
import type { PreviewReviewReason } from "@/lib/page-feed-quality";

type PreviewItem = { title: string; link: string; publishedAt: string | null; imageUrl: string | null; flagged?: boolean };
type PageFeedCandidate = {
  config: SuggestedFieldConfig;
  score: number;
  itemCount: number;
  sampleTitles: string[];
  preview: PreviewItem[];
  // Preview quality gate verdict (heuristic path only; the AI path has none).
  quality?: CandidateQuality;
  // Set on the single candidate produced by the "Let AI set this up" path so
  // the card can show an "AI" badge and the model's notes (plain text only —
  // this string is LLM output influenced by untrusted page content).
  isAi?: boolean;
  notes?: string | null;
};

interface PageFeedPanelProps {
  categoryId?: string;
  onCreated: (feed: { name: string }) => void;
  // F7: PWA share-target deep link (?sharedUrl=...) pre-fills this instead of
  // starting from an empty URL field.
  initialUrl?: string;
}

/** "heise.de/news/Blender-5-3…" — enough of the link to judge where an item points. */
function shortLink(link: string): string {
  try {
    const u = new URL(link);
    const path = u.pathname.replace(/\/+$/, "");
    return `${u.hostname.replace(/^www\./, "")}${path}`;
  } catch {
    return link;
  }
}

const REVIEW_REASON_KEYS: Record<PreviewReviewReason, string> = {
  missingDates: "review.missingDates",
  duplicates: "review.duplicates",
  mixedItems: "review.mixedItems",
  fewItems: "review.fewItems",
  outsideSection: "review.outsideSection",
  otherSites: "review.otherSites",
};

function deriveNameFromUrl(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return "";
  }
}

export function PageFeedPanel({ categoryId, onCreated, initialUrl }: PageFeedPanelProps) {
  const t = useTranslations("sidebar.webpage");
  const [url, setUrl] = useState(initialUrl ?? "");
  const format = useFormatter();
  const [candidates, setCandidates] = useState<PageFeedCandidate[] | null>(null);
  const [rejectedCount, setRejectedCount] = useState(0);
  const [selectedIndex, setSelectedIndex] = useState(0);
  const [name, setName] = useState("");
  const [suggestError, setSuggestError] = useState<string | null>(null);
  const [fullTextInfo, setFullTextInfo] = useState<{ notes: string | null } | null>(null);

  // Deep-link URL can arrive after this panel already mounted (it's rendered
  // lazily inside the Add-Feed dialog's "From web page" tab).
  useEffect(() => {
    if (initialUrl) setUrl(initialUrl);
  }, [initialUrl]);

  const suggest = useSuggestFeedFromUrl();
  const create = useCreateFeedFromPage();
  const ai = useProposeAiFeedConfig();
  const { data: aiSettings } = useAiSettings();
  const aiConfigured = Boolean(aiSettings?.provider);
  const isBusy = suggest.isPending || ai.isPending;

  const handleFindItems = async () => {
    const trimmedUrl = url.trim();
    if (!trimmedUrl) return;
    setSuggestError(null);
    setCandidates(null);
    setFullTextInfo(null);
    try {
      const result = await suggest.mutateAsync(trimmedUrl);
      if (!result.success) {
        const message = result.error || t("suggestFailed");
        setSuggestError(message);
        toast.error(message);
        return;
      }
      setCandidates(result.candidates as PageFeedCandidate[]);
      setRejectedCount(result.rejectedCount ?? 0);
      setSelectedIndex(0);
      setName(deriveNameFromUrl(trimmedUrl));
    } catch (err) {
      const message = err instanceof Error ? err.message : t("suggestFailed");
      setSuggestError(message);
      toast.error(message);
    }
  };

  const handleAiSetup = async () => {
    const trimmedUrl = url.trim();
    if (!trimmedUrl) return;
    setSuggestError(null);
    setCandidates(null);
    setFullTextInfo(null);
    try {
      const result = await ai.mutateAsync(trimmedUrl);
      if (!result.success) {
        const message = result.error || t("aiSuggestFailed");
        setSuggestError(message);
        toast.error(message);
        return;
      }
      if (result.mode === "fulltext") {
        setFullTextInfo({ notes: result.notes ?? null });
        return;
      }
      setCandidates([
        {
          config: result.config,
          score: 0,
          itemCount: result.itemCount,
          sampleTitles: result.sampleTitles,
          preview: result.preview,
          isAi: true,
          notes: result.notes ?? null,
        },
      ]);
      setSelectedIndex(0);
      setName(deriveNameFromUrl(trimmedUrl));
    } catch (err) {
      const message = err instanceof Error ? err.message : t("aiSuggestFailed");
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
      {/* The URL input gets its own full-width row: with the AI button in the
          action row below, sharing a single row squeezed the input down to a
          few characters inside the 28rem dialog. */}
      <Input
        placeholder={t("urlPlaceholder")}
        value={url}
        onChange={(e) => {
          setUrl(e.target.value);
          setCandidates(null);
          setSuggestError(null);
          setFullTextInfo(null);
        }}
        onKeyDown={(e) => {
          if (e.key === "Enter" && url.trim()) handleFindItems();
        }}
        className="h-9 text-body-sm w-full"
      />
      <div className="flex gap-1.5">
        <Button
          size="sm"
          className="h-9 px-3"
          disabled={!url.trim() || isBusy}
          onClick={handleFindItems}
        >
          {suggest.isPending ? <Loader2 className="w-4 h-4 animate-spin" /> : t("findItems")}
        </Button>
        {aiConfigured && (
          <Button
            variant="secondary"
            size="sm"
            className="h-9 px-3"
            disabled={!url.trim() || isBusy}
            onClick={handleAiSetup}
          >
            {ai.isPending ? <Loader2 className="w-4 h-4 animate-spin" /> : `✨ ${t("aiButton")}`}
          </Button>
        )}
      </div>

      {suggestError && !candidates && (
        <div className="rounded-panel border border-warning/20 bg-warning/10 px-3 py-2 text-footnote text-warning">
          {suggestError}
        </div>
      )}

      {fullTextInfo && (
        <div className="rounded-panel border border-border/60 bg-muted/40 px-3 py-2 text-footnote text-muted-foreground space-y-1">
          <p className="font-medium text-foreground">{t("aiFullTextTitle")}</p>
          <p>{t("aiFullTextHint")}</p>
          {fullTextInfo.notes && <p className="italic">{fullTextInfo.notes}</p>}
        </div>
      )}

      {candidates && candidates.length === 0 && (
        <div className="flex flex-col items-center justify-center py-8 text-center">
          <FileSearch className="size-5 text-muted-foreground/50 mb-2" />
          <p className="text-body-sm text-muted-foreground">{t("emptyTitle")}</p>
          {rejectedCount > 0 && (
            <p className="text-footnote text-muted-foreground mt-1" data-testid="page-feed-rejected">
              {t("rejectedHint", { count: rejectedCount })}
            </p>
          )}
          <p className="text-footnote text-muted-foreground mt-1">{t("emptyHint")}</p>
        </div>
      )}

      {candidates && candidates.length > 0 && (
        <>
          <ScrollArea className="h-[280px]">
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
                    "ui-control-surface flex items-start gap-2 rounded-panel border px-3 py-2 cursor-pointer",
                    selectedIndex === i && "border-primary ring-1 ring-primary/40",
                  )}
                >
                  <RadioGroupItem value={String(i)} id={`page-feed-candidate-${i}`} className="mt-0.5 shrink-0" />
                  <div className="min-w-0 flex-1 space-y-1">
                    <p className="flex flex-wrap items-center gap-1.5 text-footnote font-medium text-foreground">
                      {t("itemsFound", { count: candidate.itemCount })}
                      {candidate.isAi && (
                        <span className="inline-flex items-center gap-0.5 rounded-full bg-brand/10 px-1.5 py-0.5 text-caption font-medium text-brand">
                          ✨ {t("aiBadge")}
                        </span>
                      )}
                      {candidate.quality?.verdict === "review" && (
                        <span
                          className="inline-flex items-center gap-0.5 rounded-full bg-warning/10 px-1.5 py-0.5 text-caption font-medium text-warning"
                          data-testid="page-feed-review-badge"
                        >
                          <CircleAlert className="size-3" aria-hidden />
                          {t("review.badge")}
                        </span>
                      )}
                      {candidate.quality?.verdict === "ok" && (
                        <span className="inline-flex items-center gap-0.5 rounded-full bg-success/10 px-1.5 py-0.5 text-caption font-medium text-success">
                          <CircleCheck className="size-3" aria-hidden />
                          {t("review.okBadge")}
                        </span>
                      )}
                    </p>
                    {candidate.quality?.verdict === "review" && candidate.quality.reasons.length > 0 && (
                      <ul className="space-y-0.5 text-caption text-warning" data-testid="page-feed-review-reasons">
                        {candidate.quality.reasons.map((reason) => (
                          <li key={reason}>{t(REVIEW_REASON_KEYS[reason])}</li>
                        ))}
                      </ul>
                    )}
                    {candidate.isAi && candidate.notes && (
                      <p className="text-caption text-muted-foreground italic">{candidate.notes}</p>
                    )}
                    {candidate.preview.length > 0 ? (
                      <ul className="space-y-1 pt-0.5" aria-label={t("previewLabel")}>
                        {candidate.preview.slice(0, 4).map((item, pi) => (
                          <li
                            key={pi}
                            className={cn("min-w-0 rounded-row bg-muted px-1.5 py-1", item.flagged && "opacity-60")}
                            data-testid="page-feed-preview-item"
                          >
                            <p className="truncate text-footnote text-foreground" title={item.title}>
                              {item.title}
                            </p>
                            <p className="flex min-w-0 gap-1 text-caption text-muted-foreground">
                              <span className="truncate" title={item.link}>{shortLink(item.link)}</span>
                              <span className="shrink-0">
                                ·{" "}
                                {item.publishedAt
                                  ? format.dateTime(new Date(item.publishedAt), { dateStyle: "medium" })
                                  : t("previewNoDate")}
                              </span>
                              {item.flagged && <span className="shrink-0 text-warning">· {t("previewFlagged")}</span>}
                            </p>
                          </li>
                        ))}
                      </ul>
                    ) : (
                      candidate.sampleTitles.slice(0, 3).map((title, ti) => (
                        <p key={ti} className="text-footnote text-muted-foreground truncate">{title}</p>
                      ))
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
            className="h-9 text-body-sm"
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
