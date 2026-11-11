"use client";

import { useCallback, useRef, useState } from "react";
import { useTranslations } from "next-intl";
import { toast } from "sonner";
import { ArrowUp, Ban, ChevronDown, ChevronUp, Copy, ExternalLink, Loader2, MailX, MoreHorizontal, Send, Sparkles, Tag, Wand2 } from "lucide-react";
import { ResponsiveMenu, type OverlayMenuItem } from "@/components/ui/responsive-overlay";
import { getLayoutClass, isCoarsePointer } from "@/features/reader/layout/layout-class";
import { useOwnedOverlay } from "@/features/reader/nav/use-owned-overlay";
import { nav } from "@/features/reader/nav/store";
import { useNewsletterDialogs } from "@/components/newsletter/newsletter-actions";
import { isWebLink } from "@/lib/newsletter-constants";
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
 *
 * Same overlay as every other "…" (ResponsiveMenu): a sheet on compact touch
 * (Labels / Senden an are in-sheet steps), a dropdown with submenus for mouse
 * and keyboard; a nav overlay, so system Back closes it, not the reader.
 */
export default function ReaderMoreMenuEntry(p: ReaderMoreMenuProps | { warmup: true }) {
  return "warmup" in p ? null : <ReaderMoreMenu {...p} />;
}

function ReaderMoreMenu(p: ReaderMoreMenuProps) {
  const t = useTranslations("articleReader");
  const tNl = useTranslations("newsletterReader");
  const { article } = p;
  const newsletter = article.newsletter ?? null;
  // Newsletters without a web version link to "newsletter:…": nothing to fetch, open or copy.
  // Web feed articles keep their usual behaviour.
  const webLink = newsletter || article.feedIsNewsletter ? isWebLink(article.link) : !!article.link;
  const newsletterDialogs = useNewsletterDialogs();
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

  const [open, setOpen] = useOwnedOverlay("reader-menu");
  const triggerRef = useRef<HTMLButtonElement>(null);
  const [placement, setPlacement] = useState<{ mode: "sheet" | "menu"; anchor: { x: number; y: number } }>({ mode: "menu", anchor: { x: 0, y: 0 } });
  const openMenu = () => {
    const r = triggerRef.current?.getBoundingClientRect();
    setPlacement({
      mode: getLayoutClass() === "compact" && isCoarsePointer() ? "sheet" : "menu",
      anchor: r ? { x: Math.max(8, r.right - 256), y: p.side === "top" ? r.top - 4 : r.bottom + 4 } : { x: 8, y: 8 },
    });
    setOpen(true);
  };

  // A dialog opens only once the menu (a vaul sheet on touch) is gone.
  const afterClose = (fn: () => void) => () => void nav.closeOverlay("reader-menu").then(() => window.requestAnimationFrame(() => window.setTimeout(fn, 0)));
  const newsletterInfo = newsletter ? { unsubscribe: newsletter.unsubscribe, blockAddress: newsletter.blockAddress, feedId: article.feedId, feedName: article.feedName } : null;
  const newsletterItems: OverlayMenuItem[] = newsletterInfo
    ? [
        {
          id: "newsletter-unsubscribe",
          label: tNl("menuUnsubscribe"),
          icon: MailX,
          separated: true,
          onSelect: afterClose(() => newsletterDialogs.openUnsubscribe({ articleId: article.id }, newsletterInfo)),
        },
        ...(newsletterInfo.blockAddress
          ? [{ id: "newsletter-block", label: tNl("menuBlock"), icon: Ban, onSelect: afterClose(() => newsletterDialogs.openBlock({ articleId: article.id }, newsletterInfo)) }]
          : []),
      ]
    : [];

  const items: OverlayMenuItem[] = [
    ...(webLink
      ? [{ id: "full-text", label: p.isFetchingFullText ? t("fetching") : t("fetchFullText"), icon: p.isFetchingFullText ? Loader2 : Wand2, disabled: p.isFetchingFullText, onSelect: () => p.onFetchFullText?.(article.id) }]
      : []),
    ...(aiSettings?.provider
      ? [{ id: "ai", label: t("aiSummary"), icon: Sparkles, onSelect: () => window.dispatchEvent(new CustomEvent(SUMMARIZE_EVENT, { detail: { id: article.id } })) }]
      : []),
    {
      id: "labels",
      label: t("labels"),
      icon: Tag,
      onSelect: () => {},
      children:
        p.labels.length === 0
          ? [{ id: "no-labels", label: t("noLabels"), disabled: true, onSelect: () => {} }]
          : p.labels.map((label) => {
              const on = labelIds.includes(label.id);
              return {
                id: `label-${label.id}`,
                label: label.name,
                swatch: label.color,
                checked: on,
                onSelect: () => p.onSetLabels?.(article.id, on ? labelIds.filter((id) => id !== label.id) : Array.from(new Set([...labelIds, label.id]))),
              };
            }),
    },
    { id: "original", label: t("openOriginal"), icon: ExternalLink, disabled: !webLink, separated: true, onSelect: p.onOpenOriginal },
    { id: "copy", label: t("copyLink"), icon: Copy, disabled: !webLink, onSelect: p.onCopyLink },
    ...(canExport
      ? [
          {
            id: "send",
            label: t("sendTo"),
            icon: Send,
            onSelect: () => {},
            children: [
              ...(exportSettings?.obsidianConfigured ? [{ id: "obsidian", label: t("sendToObsidian"), disabled: buildObsidianLink.isPending, onSelect: () => void sendToObsidian() }] : []),
              ...(exportSettings?.wallabagConfigured ? [{ id: "wallabag", label: t("sendToWallabag"), disabled: exportToWallabag.isPending, onSelect: () => void sendToWallabag() }] : []),
            ],
          },
        ]
      : []),
    ...newsletterItems,
    { id: "previous", label: t("previousArticle"), icon: ChevronUp, disabled: !p.hasPrevious, separated: true, onSelect: p.onPrevious },
    { id: "next", label: t("nextArticle"), icon: ChevronDown, disabled: !p.hasNext, onSelect: p.onNext },
    { id: "top", label: t("scrollToTop"), icon: ArrowUp, onSelect: p.onScrollTop },
  ];

  return (
    <>
      <ChromeButton
        ref={triggerRef}
        aria-label={t("moreActions")}
        title={t("moreActions")}
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={openMenu}
        data-testid="reader-more-button"
      >
        <MoreHorizontal className="size-6" />
      </ChromeButton>
      <ResponsiveMenu
        open={open}
        onOpenChange={setOpen}
        mode={placement.mode}
        side={p.side}
        title={article.title}
        anchor={placement.anchor}
        items={items}
        testId="reader-menu"
        returnFocus={() => triggerRef.current}
      />
      {newsletterDialogs.element}
    </>
  );
}
