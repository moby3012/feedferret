"use client";

import type { RefObject } from "react";
import dynamic from "next/dynamic";
import { useTranslations } from "next-intl";
import { ArrowUp, MoreHorizontal } from "lucide-react";
import type { Article } from "@/lib/rss-data";
import type { ResolvedTypography } from "@/features/reader/typography/typography";
import { ChromeButton, type ReaderNavProps, type ReaderToggleProps } from "./chrome-button";
import { ReaderActionPill } from "./reader-action-pill";
import { ReaderTopBar } from "./reader-top-bar";
import "@/app/styles/reader-chrome.css";

// The chrome is its own chunk (with its CSS): it joins one frame after the
// headline anyway (reader-view.tsx), so it stays off the cold-start bytes.
// The "…" menu and the "Aa" sheet are a further level down and show an
// identical trigger until they are in.
export const loadMore = () => import("./reader-more-menu");
export const loadTypography = () => import("./reader-typography-sheet");
const ReaderMoreMenu = dynamic(loadMore, { ssr: false, loading: () => <MoreTriggerPlaceholder /> });
const ReaderTypographySheet = dynamic(loadTypography, { ssr: false, loading: () => <AaTriggerPlaceholder /> });

function MoreTriggerPlaceholder() {
  const t = useTranslations("articleReader");
  return (
    <ChromeButton aria-label={t("moreActions")} aria-disabled="true">
      <MoreHorizontal className="size-6" />
    </ChromeButton>
  );
}
function AaTriggerPlaceholder() {
  const t = useTranslations("articleReader");
  return (
    <ChromeButton aria-label={t("typography")} aria-disabled="true" className="ff-aa-btn">
      <span aria-hidden="true">Aa</span>
    </ChromeButton>
  );
}

export interface ReaderChromeProps extends ReaderNavProps, ReaderToggleProps {
  article: Article;
  barRef: RefObject<HTMLElement | null>;
  pullRef: RefObject<HTMLDivElement | null>;
  nextTitle: string | null;
  onBack: () => void;
  onOpenFeed: (feedId: string) => void;
  labels: Array<{ id: string; name: string; color: string }>;
  onSetLabels?: (articleId: string, labelIds: string[]) => void;
  onFetchFullText?: (id: string) => void;
  isFetchingFullText?: boolean;
  onCopyLink: () => void;
  onScrollTop: () => void;
  resolved: ResolvedTypography;
  effectiveSize: () => number;
}

/** Top bar (hide-on-scroll + progress), the pull-to-next indicator and the compact action pill. */
export default function ReaderChromeEntry(p: ReaderChromeProps | { warmup: true }) {
  // `warmup`: mounted once while idle so later mounts never suspend (see ReaderLazyWarmup).
  return "warmup" in p ? <Warmup /> : <ReaderChrome {...p} />;
}

function ReaderChrome(p: ReaderChromeProps) {
  const t = useTranslations("articleReader");
  const navProps: ReaderNavProps = { hasPrevious: p.hasPrevious, hasNext: p.hasNext, onPrevious: p.onPrevious, onNext: p.onNext };
  const toggles: ReaderToggleProps = {
    onToggleStar: p.onToggleStar,
    onToggleRead: p.onToggleRead,
    onToggleLater: p.onToggleLater,
    onShare: p.onShare,
    onOpenOriginal: p.onOpenOriginal,
  };
  const more = (side: "top" | "bottom") => (
    <ReaderMoreMenu
      {...navProps}
      side={side}
      article={p.article}
      labels={p.labels}
      onSetLabels={p.onSetLabels}
      onFetchFullText={p.onFetchFullText}
      isFetchingFullText={p.isFetchingFullText}
      onOpenOriginal={p.onOpenOriginal}
      onCopyLink={p.onCopyLink}
      onScrollTop={p.onScrollTop}
    />
  );
  return (
    <>
      <ReaderTopBar
        ref={p.barRef}
        article={p.article}
        {...navProps}
        {...toggles}
        onBack={p.onBack}
        onOpenFeed={p.onOpenFeed}
        typography={<ReaderTypographySheet resolved={p.resolved} effectiveSize={p.effectiveSize} />}
        more={more("bottom")}
      />
      {p.hasNext && (
        <div ref={p.pullRef} className="ff-reader-pull" data-pull="idle" data-testid="reader-pull" aria-hidden="true">
          <span className="ff-reader-pull-ring">
            <ArrowUp className="size-4" />
          </span>
          <span className="ff-reader-pull-label">
            <span className="ff-reader-pull-hint" data-when="tracking">
              {t("pullToNext")}
            </span>
            <span className="ff-reader-pull-hint" data-when="armed">
              {t("releaseForNext")}
            </span>
            {p.nextTitle && <span className="ff-reader-pull-title">{p.nextTitle}</span>}
          </span>
        </div>
      )}
      <ReaderActionPill article={p.article} {...toggles} more={more("top")} />
    </>
  );
}

/** Resolves the nested lazy menus once, rendering nothing. */
function Warmup() {
  return (
    <>
      <ReaderMoreMenu warmup />
      <ReaderTypographySheet warmup />
    </>
  );
}
