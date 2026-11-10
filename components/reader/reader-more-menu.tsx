"use client";

import { useCallback } from "react";
import { useTranslations } from "next-intl";
import { toast } from "sonner";
import { ArrowUp, ChevronDown, ChevronUp, Copy, ExternalLink, Loader2, MoreHorizontal, Send, Sparkles, Tag, Wand2 } from "lucide-react";
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { useAiSettings, useBuildObsidianExportLink, useExportArticleToWallabag, useExportSettings } from "@/hooks/use-rss-data";
import type { Article } from "@/lib/rss-data";
import { SUMMARIZE_EVENT } from "./reader-events";
import { ChromeButton, type ReaderNavProps } from "./chrome-button";


export interface ReaderMoreMenuProps extends ReaderNavProps {
  article: Article;
  labels: Array<{ id: string; name: string; color: string }>;
  onSetLabels?: (articleId: string, labelIds: string[]) => void;
  onFetchFullText?: (articleId: string) => void;
  isFetchingFullText?: boolean;
  onOpenOriginal: () => void;
  onCopyLink: () => void;
  onScrollTop: () => void;
  side: "top" | "bottom";
}

/**
 * The reader's "…" (lazy chunk; its trigger placeholder is identical): Volltext
 * abrufen · KI-Zusammenfassung · Labels · Original öffnen · Link kopieren ·
 * Senden an · Vorheriger/Nächster Artikel · Nach oben.
 */
export default function ReaderMoreMenuEntry(p: ReaderMoreMenuProps | { warmup: true }) {
  return "warmup" in p ? null : <ReaderMoreMenu {...p} />;
}

function ReaderMoreMenu(p: ReaderMoreMenuProps) {
  const t = useTranslations("articleReader");
  const { article } = p;
  const { data: aiSettings } = useAiSettings();
  const { data: exportSettings } = useExportSettings();
  const buildObsidianLink = useBuildObsidianExportLink();
  const exportToWallabag = useExportArticleToWallabag();
  const canExport = Boolean(exportSettings?.obsidianConfigured || exportSettings?.wallabagConfigured);
  const labelIds = article.labels?.map((item) => item.label.id) ?? [];

  const sendToObsidian = useCallback(async () => {
    const result = await buildObsidianLink.mutateAsync(article.id);
    if (!result.success || !result.url) {
      toast.error(result.error || t("sendToFailed"));
      return;
    }
    // Hands off to the OS/Obsidian app — no data leaves this server.
    window.location.href = result.url;
    toast.success(t("sendToObsidianSuccess"));
  }, [article.id, buildObsidianLink, t]);

  const sendToWallabag = useCallback(async () => {
    const result = await exportToWallabag.mutateAsync(article.id);
    if (!result.success) {
      toast.error(result.error || t("sendToFailed"));
      return;
    }
    toast.success(t("sendToWallabagSuccess"));
  }, [article.id, exportToWallabag, t]);

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <ChromeButton aria-label={t("moreActions")} title={t("moreActions")}>
          <MoreHorizontal className="size-6" />
        </ChromeButton>
      </DropdownMenuTrigger>
      <DropdownMenuContent
        side={p.side}
        align="end"
        sideOffset={10}
        className="w-64 rounded-panel p-1.5"
        // Esc closes the menu only — not also the reader (the shell's global Esc).
        onEscapeKeyDown={(e) => e.stopPropagation()}
      >
        {article.link && (
          <DropdownMenuItem onClick={() => p.onFetchFullText?.(article.id)} disabled={p.isFetchingFullText}>
            {p.isFetchingFullText ? <Loader2 className="animate-spin" /> : <Wand2 />}
            {p.isFetchingFullText ? t("fetching") : t("fetchFullText")}
          </DropdownMenuItem>
        )}
        {aiSettings?.provider && (
          <DropdownMenuItem onClick={() => window.dispatchEvent(new CustomEvent(SUMMARIZE_EVENT, { detail: { id: article.id } }))}>
            <Sparkles />
            {t("aiSummary")}
          </DropdownMenuItem>
        )}
        <DropdownMenuSub>
          <DropdownMenuSubTrigger>
            <Tag />
            {t("labels")}
          </DropdownMenuSubTrigger>
          <DropdownMenuSubContent className="w-56 rounded-panel p-1.5">
            {p.labels.length === 0 ? (
              <div className="px-2 py-3 text-body-sm text-muted-foreground">{t("noLabels")}</div>
            ) : (
              p.labels.map((label) => (
                <DropdownMenuCheckboxItem
                  key={label.id}
                  checked={labelIds.includes(label.id)}
                  onSelect={(e) => e.preventDefault()}
                  onCheckedChange={(on) =>
                    p.onSetLabels?.(article.id, on ? Array.from(new Set([...labelIds, label.id])) : labelIds.filter((id) => id !== label.id))
                  }
                >
                  <span className="size-2.5 rounded-full" style={{ backgroundColor: label.color }} />
                  {label.name}
                </DropdownMenuCheckboxItem>
              ))
            )}
          </DropdownMenuSubContent>
        </DropdownMenuSub>
        <DropdownMenuSeparator />
        <DropdownMenuItem onClick={p.onOpenOriginal} disabled={!article.link}>
          <ExternalLink />
          {t("openOriginal")}
        </DropdownMenuItem>
        <DropdownMenuItem onClick={p.onCopyLink} disabled={!article.link}>
          <Copy />
          {t("copyLink")}
        </DropdownMenuItem>
        {canExport && (
          <DropdownMenuSub>
            <DropdownMenuSubTrigger>
              <Send />
              {t("sendTo")}
            </DropdownMenuSubTrigger>
            <DropdownMenuSubContent className="w-48 rounded-panel p-1.5">
              {exportSettings?.obsidianConfigured && (
                <DropdownMenuItem onClick={sendToObsidian} disabled={buildObsidianLink.isPending}>
                  {t("sendToObsidian")}
                </DropdownMenuItem>
              )}
              {exportSettings?.wallabagConfigured && (
                <DropdownMenuItem onClick={sendToWallabag} disabled={exportToWallabag.isPending}>
                  {t("sendToWallabag")}
                </DropdownMenuItem>
              )}
            </DropdownMenuSubContent>
          </DropdownMenuSub>
        )}
        <DropdownMenuSeparator />
        <DropdownMenuItem onClick={p.onPrevious} disabled={!p.hasPrevious}>
          <ChevronUp />
          {t("previousArticle")}
        </DropdownMenuItem>
        <DropdownMenuItem onClick={p.onNext} disabled={!p.hasNext}>
          <ChevronDown />
          {t("nextArticle")}
        </DropdownMenuItem>
        <DropdownMenuItem onClick={p.onScrollTop}>
          <ArrowUp />
          {t("scrollToTop")}
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
