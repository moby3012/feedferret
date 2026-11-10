"use client";

import { memo, useEffect, useRef, type KeyboardEvent, type MouseEvent, type ReactNode } from "react";
import { useFormatter, useNow, useTranslations } from "next-intl";
import {
  Bookmark,
  BookmarkMinus,
  Check,
  CheckCircle2,
  Circle,
  CircleDot,
  Headphones,
  Image as ImageIcon,
  Layers,
  MessageSquareText,
  Play,
  ShieldOff,
  Star,
  StarOff,
  type LucideIcon,
} from "lucide-react";
import type { LegacyArticle } from "@/features/articles/legacy-adapter";
import { createSwipeRow, documentDir, type LongPressPoint, type SwipeAction, type SwipeActionId } from "@/lib/gestures";
import { highlightText } from "@/lib/highlight-search-terms";
import { cn } from "@/lib/utils";
import { FeedFavicon } from "./feed-favicon";

// Row v2 (spec §4.5): five content kinds × three densities. Flat, full-bleed
// rows (magazine = cards); unread = brand dot + weight; read = secondary text
// and dimmed media, never a dimmed row. The harness contract stays:
// `[data-article-id] > [role=button][aria-label="[Unread: ]<title> — <feed>"]`.

export type Density = "list" | "minimal" | "magazine";

export interface RowSwipeMap {
  /** Swipe towards inline-end (→ in LTR). */
  end: SwipeActionId;
  /** Swipe towards inline-start (← in LTR). */
  start: SwipeActionId;
}

/** Story cluster card state of a row: `more` = other sources of the story. */
export interface RowCluster {
  id: string;
  more: number;
  expanded: boolean;
}

/** Stable handler bag (one object per list view; rows never re-render for it). */
export interface RowHandlers {
  open(article: LegacyArticle): void;
  toggleRead(id: string): void;
  toggleStar(id: string): void;
  toggleLater(id: string): void;
  releaseSpoiler?: (id: string) => void;
  openMenu(id: string, point: LongPressPoint, returnFocus: HTMLElement): void;
  toggleCluster(clusterId: string): void;
  swipeEnabled(): boolean;
  /** Read-on-scroll: registers an unread row with the list's shared observer. */
  observeUnread?(el: HTMLElement, id: string): () => void;
}

export interface ArticleRowProps {
  article: LegacyArticle;
  density: Density;
  selected: boolean;
  handlers: RowHandlers;
  swipeMap: RowSwipeMap;
  cluster: RowCluster | null;
  /** Member row inside an expanded story card. */
  nested?: boolean;
  highlightTerms?: string[];
  canReleaseSpoiler?: boolean;
}

const DAY_MS = 24 * 60 * 60 * 1000;

export function formatDuration(secs: number | null | undefined): string | null {
  if (secs == null || !Number.isFinite(secs) || secs <= 0) return null;
  const s = Math.round(secs);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = String(s % 60).padStart(2, "0");
  return h > 0 ? `${h}:${String(m).padStart(2, "0")}:${sec}` : `${m}:${sec}`;
}

function useRowTime(iso: string): string {
  const format = useFormatter();
  const now = useNow();
  const date = new Date(iso);
  const age = now.getTime() - date.getTime();
  if (age >= 0 && age < DAY_MS) return format.relativeTime(date, { now, style: "narrow" });
  return format.dateTime(date, { day: "2-digit", month: "2-digit" });
}

export const ArticleRow = memo(function ArticleRow(p: ArticleRowProps) {
  const t = useTranslations("articleList");
  const { article, density, handlers } = p;
  const hostRef = useRef<HTMLDivElement>(null);
  const contentRef = useRef<HTMLDivElement>(null);
  const live = useRef(p);
  live.current = p;

  // Swipe + long-press: wired once per row; reads the latest props through `live`.
  useEffect(() => {
    const host = hostRef.current;
    const content = contentRef.current;
    if (!host || !content) return;
    const action = (which: SwipeActionId): SwipeAction | null => {
      if (which === "none") return null;
      return {
        id: which,
        commit: () => {
          const { article: a, handlers: h } = live.current;
          if (which === "read") h.toggleRead(a.id);
          else if (which === "later") h.toggleLater(a.id);
          else h.toggleStar(a.id);
        },
      };
    };
    return createSwipeRow(host, {
      content,
      enabled: () => live.current.handlers.swipeEnabled(),
      dir: documentDir,
      leading: () => action(live.current.swipeMap.end),
      trailing: () => action(live.current.swipeMap.start),
      onLongPress: (point) => live.current.handlers.openMenu(live.current.article.id, point, content),
    });
  }, []);

  // Read-on-scroll (one shared observer per list).
  const observe = handlers.observeUnread;
  useEffect(() => {
    const host = hostRef.current;
    if (!observe || !host || article.isRead) return;
    return observe(host, article.id);
  }, [observe, article.id, article.isRead]);

  const shownTitle = article.displayTitle || article.title;
  const label = `${article.isRead ? "" : "Unread: "}${shownTitle} — ${article.feedName}`;
  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.target !== e.currentTarget) return;
    if (e.key === "ContextMenu" || (e.shiftKey && e.key === "F10")) {
      // Keyboard twin of long-press / right-click: the row menu, anchored at the row.
      e.preventDefault();
      const r = e.currentTarget.getBoundingClientRect();
      handlers.openMenu(article.id, { x: r.left + Math.min(48, r.width / 2), y: r.top + Math.min(48, r.height / 2), pointerType: "keyboard" }, e.currentTarget);
      return;
    }
    if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      handlers.open(article);
    }
  };

  return (
    <div
      ref={hostRef}
      className="ff-row"
      data-article-id={article.id}
      data-density={density}
      data-kind={article.kind}
      data-unread={article.isRead ? undefined : ""}
      data-selected={p.selected ? "" : undefined}
      data-nested={p.nested ? "" : undefined}
    >
      <SwipeReveal side="leading" action={p.swipeMap.end} article={article} />
      <SwipeReveal side="trailing" action={p.swipeMap.start} article={article} />
      <div
        ref={contentRef}
        role="button"
        tabIndex={0}
        aria-label={label}
        aria-pressed={p.selected}
        aria-describedby={article.displayTitle ? `orig-title-${article.id}` : undefined}
        onClick={() => handlers.open(article)}
        onKeyDown={onKeyDown}
        className="ff-row-content"
      >
        {article.displayTitle && (
          <span id={`orig-title-${article.id}`} className="sr-only">
            {t("originalTitle", { title: article.title })}
          </span>
        )}
        {density === "minimal" ? <MinimalBody {...p} shownTitle={shownTitle} /> : density === "magazine" ? <MagazineBody {...p} shownTitle={shownTitle} /> : <ListBody {...p} shownTitle={shownTitle} />}
      </div>
    </div>
  );
});

type BodyProps = ArticleRowProps & { shownTitle: string };

// ---------------------------------------------------------------- pieces

function SwipeReveal({ side, action, article }: { side: "leading" | "trailing"; action: SwipeActionId; article: LegacyArticle }) {
  const t = useTranslations("articleList");
  if (action === "none") return null;
  let Icon: LucideIcon;
  let text: string;
  if (action === "read") {
    Icon = article.isRead ? CircleDot : Check;
    text = article.isRead ? t("swipeUnread") : t("swipeRead");
  } else if (action === "later") {
    Icon = article.isReadLater ? BookmarkMinus : Bookmark;
    text = article.isReadLater ? t("swipeLaterRemove") : t("swipeLater");
  } else {
    Icon = article.isStarred ? StarOff : Star;
    text = article.isStarred ? t("swipeUnstar") : t("swipeStar");
  }
  return (
    <div className="ff-row-reveal" data-side={side} data-action={action} aria-hidden="true">
      {side === "trailing" && <span className="ff-row-reveal-label text-caption font-semibold">{text}</span>}
      <Icon className="ff-row-reveal-icon size-6" />
      {side === "leading" && <span className="ff-row-reveal-label text-caption font-semibold">{text}</span>}
    </div>
  );
}

function Title({ text, terms, original, className }: { text: string; terms?: string[]; original?: string | null; className?: string }) {
  const t = useTranslations("articleList");
  return (
    <h3 className={cn("ff-row-dot break-words [overflow-wrap:anywhere]", className)} title={original ? t("originalTitle", { title: original }) : undefined}>
      {terms?.length ? highlightText(text, terms) : text}
    </h3>
  );
}

function titleTone(read: boolean) {
  return read ? "font-medium text-muted-foreground" : "font-semibold text-foreground";
}

function SponsoredChip() {
  const t = useTranslations("articleList");
  return (
    <span
      data-testid="sponsored-chip"
      title={t("sponsoredHint")}
      className="inline-flex h-4 shrink-0 items-center rounded-chip bg-warning-subtle px-1.5 text-caption font-semibold text-warning"
    >
      {t("sponsored")}
    </span>
  );
}

function KindGlyph({ kind }: { kind: LegacyArticle["kind"] }) {
  const t = useTranslations("articleList");
  const map: Partial<Record<LegacyArticle["kind"], [LucideIcon, string]>> = {
    video: [Play, t("kindVideo")],
    audio: [Headphones, t("kindAudio")],
    image: [ImageIcon, t("kindImage")],
    social: [MessageSquareText, t("kindSocial")],
  };
  const hit = map[kind];
  if (!hit) return null;
  const [Icon, label] = hit;
  return <Icon className="size-3.5 shrink-0 text-muted-foreground" aria-label={label} role="img" />;
}

function SourceLine({ article, faviconSize = 14, minimal = false }: { article: LegacyArticle; faviconSize?: number; minimal?: boolean }) {
  const t = useTranslations("articleList");
  const time = useRowTime(article.publishedAt);
  return (
    <div className="flex min-w-0 items-center gap-1.5 text-footnote text-muted-foreground">
      <FeedFavicon icon={article.feedIcon} name={article.feedName} articleLink={article.link} size={faviconSize} />
      <span className="min-w-0 truncate">{article.feedName}</span>
      {article.isSponsored && <SponsoredChip />}
      {(article.duplicateCount ?? 0) > 0 && (
        <span
          className="inline-flex shrink-0 items-center gap-0.5 rounded-chip bg-muted px-1 text-caption"
          title={`${t("alsoIn")} ${article.duplicateCount} ${t("otherFeeds", { count: article.duplicateCount ?? 0 })}`}
        >
          <Layers className="size-2.5" aria-hidden />
          {article.duplicateCount}
        </span>
      )}
      {article.isDuplicate && article.canonicalFeedName && (
        <span className="inline-flex shrink-0 items-center gap-0.5 rounded-chip bg-muted/60 px-1 text-caption" title={`${t("firstSeenIn")}: ${article.canonicalFeedName}`}>
          <Layers className="size-2.5" aria-hidden />
          {t("duplicateBadge")}
        </span>
      )}
      <span aria-hidden className="shrink-0 opacity-50">
        ·
      </span>
      {minimal && <KindGlyph kind={article.kind} />}
      <time dateTime={article.publishedAt} className="shrink-0 whitespace-nowrap tabular-nums">
        {time}
      </time>
      <StateGlyphs article={article} />
    </div>
  );
}

/** Trailing state glyphs (non-interactive; the buttons carry the actions). */
function StateGlyphs({ article }: { article: LegacyArticle }) {
  if (!article.isStarred && !article.isReadLater) return null;
  return (
    <span className="ms-auto flex shrink-0 items-center gap-1 ps-1" aria-hidden>
      {article.isStarred && <Star className="size-3 fill-brand-secondary text-brand-secondary" />}
      {article.isReadLater && <Bookmark className="size-3 fill-current text-brand" />}
    </span>
  );
}

function ClusterChip({ cluster, onToggle }: { cluster: RowCluster; onToggle(): void }) {
  const t = useTranslations("articleList");
  return (
    <button
      type="button"
      data-testid="cluster-toggle"
      aria-expanded={cluster.expanded}
      aria-label={`${cluster.expanded ? t("hideSources") : t("showSources")} (${t("moreSources", { count: cluster.more })})`}
      onClick={(e) => {
        e.stopPropagation();
        onToggle();
      }}
      className={cn(
        "hit-slop inline-flex h-6 shrink-0 items-center gap-1 rounded-chip border border-divider px-1.5 text-caption font-semibold transition-colors duration-(--dur-fast)",
        cluster.expanded ? "bg-accent-subtle text-foreground" : "text-muted-foreground hover:text-foreground",
      )}
    >
      <Layers className="size-3" aria-hidden />
      {t("moreSources", { count: cluster.more })}
    </button>
  );
}

function ActionButton({ label, onClick, children, active, tone, size }: { label: string; onClick(): void; children: ReactNode; active?: boolean; tone: "read" | "star" | "later" | "warn"; size: "sm" | "md" }) {
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      onClick={(e: MouseEvent) => {
        e.stopPropagation();
        onClick();
      }}
      className={cn(
        "hit-slop inline-flex shrink-0 items-center justify-center transition-colors duration-(--dur-fast)",
        size === "md" ? "size-8 rounded-control" : "size-7 rounded-chip",
        "text-muted-foreground hover:bg-surface-sunken hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
        active && tone === "star" && "text-brand-secondary hover:text-brand-secondary",
        active && tone === "later" && "bg-accent-subtle text-foreground",
        tone === "warn" && "text-warning hover:text-warning",
      )}
    >
      {children}
    </button>
  );
}

function RowActions({ article, handlers, canReleaseSpoiler, size }: { article: LegacyArticle; handlers: RowHandlers; canReleaseSpoiler?: boolean; size: "sm" | "md" }) {
  const t = useTranslations("articleList");
  const icon = size === "md" ? "size-4" : "size-3.5";
  return (
    <div className="flex shrink-0 items-center gap-0.5">
      <ActionButton size={size} tone="read" label={article.isRead ? t("markAsUnread") : t("markAsRead")} onClick={() => handlers.toggleRead(article.id)}>
        {article.isRead ? <Circle className={icon} /> : <CheckCircle2 className={icon} />}
      </ActionButton>
      <ActionButton size={size} tone="star" active={article.isStarred} label={article.isStarred ? t("removeStar") : t("star")} onClick={() => handlers.toggleStar(article.id)}>
        <Star className={cn(icon, article.isStarred && "fill-brand-secondary")} />
      </ActionButton>
      <ActionButton size={size} tone="later" active={article.isReadLater} label={article.isReadLater ? t("removeFromReadLater") : t("saveToReadLater")} onClick={() => handlers.toggleLater(article.id)}>
        <Bookmark className={cn(icon, article.isReadLater && "fill-current")} />
      </ActionButton>
      {canReleaseSpoiler && handlers.releaseSpoiler && (
        <ActionButton size={size} tone="warn" label={t("releaseSpoiler")} onClick={() => handlers.releaseSpoiler?.(article.id)}>
          <ShieldOff className={icon} />
        </ActionButton>
      )}
    </div>
  );
}

function Labels({ article }: { article: LegacyArticle }) {
  if (!article.labels?.length) return null;
  return (
    <div className="mt-1.5 flex flex-wrap gap-1.5">
      {article.labels.slice(0, 2).map((item) => (
        <span key={item.label.id} className="inline-flex h-5 items-center gap-1 rounded-chip bg-muted px-1.5 text-caption text-muted-foreground">
          <span className="size-1.5 rounded-full" style={{ backgroundColor: item.label.color }} />
          {item.label.name}
        </span>
      ))}
    </div>
  );
}

function Img({ src, className }: { src: string; className?: string }) {
  // eslint-disable-next-line @next/next/no-img-element
  return <img src={src} alt="" loading="lazy" decoding="async" draggable={false} className={cn("size-full object-cover", className)} />;
}

function PlayDisc({ size = 28 }: { size?: number }) {
  return (
    <span className="absolute inset-0 flex items-center justify-center" aria-hidden>
      <span className="flex items-center justify-center rounded-full bg-black/55 text-white" style={{ width: size, height: size }}>
        <Play className="size-3.5 translate-x-px fill-current" />
      </span>
    </span>
  );
}

function DurationChip({ secs }: { secs: number | null | undefined }) {
  const t = useTranslations("articleList");
  const text = formatDuration(secs);
  if (!text) return null;
  return (
    <span aria-label={t("duration", { time: text })} className="absolute bottom-1 end-1 rounded-chip bg-black/60 px-1 py-0.5 text-caption tabular-nums text-white">
      {text}
    </span>
  );
}

/** Square / 16:9 media box with a fixed footprint; placeholder when there is no image. */
function MediaBox({ article, className, children, placeholder }: { article: LegacyArticle; className: string; children?: ReactNode; placeholder?: LucideIcon }) {
  const Placeholder = placeholder;
  return (
    <div className={cn("ff-row-media relative shrink-0 overflow-clip bg-surface-sunken ring-1 ring-inset ring-foreground/10", className)}>
      {article.imageUrl ? <Img src={article.imageUrl} /> : Placeholder ? <Placeholder className="absolute inset-0 m-auto size-6 text-muted-foreground" aria-hidden /> : null}
      {children}
    </div>
  );
}

// ---------------------------------------------------------------- list

function ListBody(p: BodyProps) {
  const { article } = p;
  const kind = article.kind;
  const meta = (
    <div className="mt-1.5 flex min-h-8 min-w-0 items-center gap-2 text-footnote text-muted-foreground">
      {kind === "audio" && formatDuration(article.media?.durationSecs) && <span className="tabular-nums">{formatDuration(article.media?.durationSecs)}</span>}
      {article.author && <span className="min-w-0 max-w-32 truncate">{article.author}</span>}
      {p.cluster && <ClusterChip cluster={p.cluster} onToggle={() => p.handlers.toggleCluster(p.cluster!.id)} />}
      <span className="ms-auto" />
      <RowActions article={article} handlers={p.handlers} canReleaseSpoiler={p.canReleaseSpoiler} size="md" />
    </div>
  );

  if (kind === "social") {
    return (
      <div className="px-(--gutter) py-(--row-pad-y)">
        <SourceLine article={article} faviconSize={20} />
        <p className={cn("ff-row-dot mt-1.5 line-clamp-6 whitespace-pre-line text-body break-words [overflow-wrap:anywhere]", article.isRead ? "text-muted-foreground" : "text-foreground")}>
          {p.highlightTerms?.length ? highlightText(article.excerpt || p.shownTitle, p.highlightTerms) : article.excerpt || p.shownTitle}
        </p>
        {article.imageUrl && <MediaBox article={article} className="ff-media-wide mt-2 rounded-row" />}
        <Labels article={article} />
        {meta}
      </div>
    );
  }

  if (kind === "image") {
    return (
      <div className="px-(--gutter) py-(--row-pad-y)">
        <SourceLine article={article} />
        <MediaBox article={article} className="ff-media-image mt-2 rounded-row" placeholder={ImageIcon} />
        <Title text={p.shownTitle} terms={p.highlightTerms} original={article.displayTitle ? article.title : null} className={cn("mt-2 line-clamp-1 text-row-title", article.isRead ? "font-medium text-muted-foreground" : "font-medium text-foreground")} />
        <Labels article={article} />
        {meta}
      </div>
    );
  }

  const media =
    kind === "video" ? (
      <MediaBox article={article} className="ff-media-video rounded-control" placeholder={Play}>
        {article.imageUrl && <PlayDisc />}
        <DurationChip secs={article.media?.durationSecs} />
      </MediaBox>
    ) : kind === "audio" ? (
      <MediaBox article={article} className="ff-media-audio rounded-row" placeholder={Headphones}>
        {article.imageUrl && <PlayDisc />}
      </MediaBox>
    ) : article.imageUrl ? (
      <MediaBox article={article} className="ff-media-thumb rounded-control" />
    ) : null;

  const summaryLines = kind === "article" ? "line-clamp-2" : "line-clamp-1";
  return (
    <div className="px-(--gutter) py-(--row-pad-y)">
      <div className="flex gap-3">
        <div className="min-w-0 flex-1">
          <SourceLine article={article} />
          <Title text={p.shownTitle} terms={p.highlightTerms} original={article.displayTitle ? article.title : null} className={cn("mt-1 line-clamp-2 text-row-title", titleTone(article.isRead))} />
          {article.excerpt && (
            <p className={cn("mt-1 text-body-sm text-muted-foreground break-words [overflow-wrap:anywhere]", summaryLines)}>
              {p.highlightTerms?.length ? highlightText(article.excerpt, p.highlightTerms) : article.excerpt}
            </p>
          )}
          <Labels article={article} />
        </div>
        {media && <div className="pt-5">{media}</div>}
      </div>
      {meta}
    </div>
  );
}

// ---------------------------------------------------------------- minimal

function MinimalBody(p: BodyProps) {
  const { article } = p;
  const time = useRowTime(article.publishedAt);
  return (
    <div className="flex min-h-11 min-w-0 items-center gap-2 px-(--gutter) py-1 fine:min-h-9">
      <FeedFavicon icon={article.feedIcon} name={article.feedName} articleLink={article.link} size={14} />
      <Title
        text={article.kind === "social" ? article.excerpt || p.shownTitle : p.shownTitle}
        terms={p.highlightTerms}
        original={article.displayTitle ? article.title : null}
        className={cn("min-w-0 flex-1 truncate text-body-sm", titleTone(article.isRead))}
      />
      {article.isSponsored && <SponsoredChip />}
      {p.cluster && <ClusterChip cluster={p.cluster} onToggle={() => p.handlers.toggleCluster(p.cluster!.id)} />}
      <KindGlyph kind={article.kind} />
      <time dateTime={article.publishedAt} className="shrink-0 whitespace-nowrap text-footnote tabular-nums text-muted-foreground">
        {time}
      </time>
      <RowActions article={article} handlers={p.handlers} canReleaseSpoiler={p.canReleaseSpoiler} size="sm" />
    </div>
  );
}

// ---------------------------------------------------------------- magazine

function MagazineBody(p: BodyProps) {
  const { article } = p;
  const kind = article.kind;
  const footer = (
    <div className="mt-auto flex min-h-8 items-center gap-2 pt-2">
      {p.cluster && <ClusterChip cluster={p.cluster} onToggle={() => p.handlers.toggleCluster(p.cluster!.id)} />}
      <span className="ms-auto" />
      <RowActions article={article} handlers={p.handlers} canReleaseSpoiler={p.canReleaseSpoiler} size="sm" />
    </div>
  );
  const title = (lines: string) => (
    <Title text={p.shownTitle} terms={p.highlightTerms} original={article.displayTitle ? article.title : null} className={cn("mt-1.5 text-row-title", lines, titleTone(article.isRead))} />
  );

  let top: ReactNode = null;
  if (kind === "video") {
    top = (
      <MediaBox article={article} className="aspect-video w-full" placeholder={Play}>
        <PlayDisc size={40} />
        <DurationChip secs={article.media?.durationSecs} />
      </MediaBox>
    );
  } else if (kind === "image") {
    top = <MediaBox article={article} className="ff-media-image" placeholder={ImageIcon} />;
  } else if (kind === "article" && article.imageUrl) {
    top = <MediaBox article={article} className="aspect-video w-full" />;
  }

  return (
    <div className="flex h-full flex-col">
      {top}
      <div className="flex flex-1 flex-col p-3.5">
        <SourceLine article={article} />
        {kind === "audio" ? (
          <div className="mt-2 flex gap-3">
            <MediaBox article={article} className="ff-media-cover rounded-row" placeholder={Headphones}>
              {article.imageUrl && <PlayDisc />}
            </MediaBox>
            <div className="min-w-0 flex-1">
              {title("line-clamp-3")}
              {formatDuration(article.media?.durationSecs) && <div className="mt-1 text-footnote tabular-nums text-muted-foreground">{formatDuration(article.media?.durationSecs)}</div>}
            </div>
          </div>
        ) : kind === "social" ? (
          <>
            <p className={cn("ff-row-dot mt-1.5 line-clamp-8 whitespace-pre-line text-body break-words [overflow-wrap:anywhere]", article.isRead ? "text-muted-foreground" : "text-foreground")}>{article.excerpt || p.shownTitle}</p>
            {article.imageUrl && <MediaBox article={article} className="ff-media-wide mt-2 rounded-row" />}
          </>
        ) : (
          <>
            {title(kind === "image" ? "line-clamp-2" : "line-clamp-3")}
            {kind === "article" && article.excerpt && (
              <p className="mt-1 line-clamp-3 text-body-sm text-muted-foreground break-words [overflow-wrap:anywhere]">
                {p.highlightTerms?.length ? highlightText(article.excerpt, p.highlightTerms) : article.excerpt}
              </p>
            )}
          </>
        )}
        <Labels article={article} />
        {footer}
      </div>
    </div>
  );
}
