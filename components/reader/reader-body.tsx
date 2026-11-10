"use client";

import { useCallback, useEffect, useState } from "react";
import { useTranslations } from "next-intl";
import { AlertCircle, ExternalLink, Loader2, RotateCw, Sparkles, WifiOff } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useOnline } from "@/features/bootstrap/online";
import { useAiSettings, useSummarizeArticle } from "@/hooks/use-rss-data";
import type { Article } from "@/lib/rss-data";
import { SUMMARIZE_EVENT } from "./reader-events";
// KaTeX math (fonts + layout CSS; no colours of its own — it inherits
// .article-content's theme-aware text colour) and the syntax-highlighting
// theme of fenced code blocks (one dark theme: prose code blocks have a fixed
// dark background in both site themes). They ship with this lazily loaded
// chunk, off the cold-start path.
import "katex/dist/katex.min.css";
import "highlight.js/styles/atom-one-dark.css";

export interface ReaderBodyProps {
  article: Article;
  /** The detail is still in flight: render nothing yet (the reader shows the skeleton). */
  loading?: boolean;
  /** The detail request failed: an inline error with retry instead of the no-content card. */
  error?: { retrying: boolean; retry: () => void } | null;
  hideImages: boolean;
  onFetchFullText?: (articleId: string) => void;
  isFetchingFullText?: boolean;
  onOpenOriginal: () => void;
}

/**
 * Article body (lazy chunk): the AI summary card, the server-sanitized HTML
 * (`article.content` comes from GET /api/app/articles/:id — stored HTML
 * sanitized at sync, or Markdown rendered + sanitized on the server; nothing
 * is parsed or sanitized here) and the teaser / no-content fallbacks.
 */
export default function ReaderBodyEntry(p: ReaderBodyProps | { warmup: true }) {
  return "warmup" in p ? null : <ReaderBody {...p} />;
}

function ReaderBody({ article, loading, error, hideImages, onFetchFullText, isFetchingFullText, onOpenOriginal }: ReaderBodyProps) {
  const t = useTranslations("articleReader");
  if (loading) return null;
  if (error) return <BodyError error={error} hasLink={!!article.link} onOpenOriginal={onOpenOriginal} />;
  const html = article.content ?? "";
  const hasContent = html.trim().length > 0;
  return (
    <>
      <AiSummaryCard article={article} />
      {hasContent ? (
        <div className={`article-content${hideImages ? " hide-images" : ""}`} dangerouslySetInnerHTML={{ __html: html }} />
      ) : (
        <div className="ff-reader-card text-center">
          <p className="mb-1 text-body-sm font-medium text-foreground">{t("noContent")}</p>
          <p className="mb-4 text-body-sm text-muted-foreground">{t("noContentDescription")}</p>
          {article.link && (
            <Button onClick={onOpenOriginal} variant="outline">
              <ExternalLink />
              {t("openOriginal")}
            </Button>
          )}
        </div>
      )}
      {hasContent && article.link && html.length < 900 && (
        <div className="ff-reader-card mt-10">
          <p className="mb-4 text-body-sm text-muted-foreground">{t("noContentDescription")}</p>
          {isFetchingFullText && (
            <div className="mb-4 flex items-center gap-2 text-body-sm text-muted-foreground" role="status" aria-live="polite">
              <Loader2 className="size-4 animate-spin" />
              {t("fetchingFullTextStatus")}
            </div>
          )}
          <div className="flex flex-wrap gap-2">
            <Button onClick={() => onFetchFullText?.(article.id)} disabled={isFetchingFullText}>
              {isFetchingFullText ? <Loader2 className="animate-spin" /> : <Sparkles />}
              {isFetchingFullText ? t("fetching") : t("fetchFullText")}
            </Button>
            <Button onClick={onOpenOriginal} variant="outline">
              <ExternalLink />
              {t("openOriginal")}
            </Button>
          </div>
        </div>
      )}
    </>
  );
}

function BodyError({ error, hasLink, onOpenOriginal }: { error: { retrying: boolean; retry: () => void }; hasLink: boolean; onOpenOriginal: () => void }) {
  const t = useTranslations("articleReader");
  const online = useOnline();
  const Icon = online ? AlertCircle : WifiOff;
  return (
    <div className="ff-reader-card text-center" role="alert" data-testid="reader-body-error">
      <Icon className="mx-auto mb-2 size-5 text-warning" aria-hidden />
      <p className="mb-1 text-body-sm font-medium text-foreground">{online ? t("bodyErrorTitle") : t("bodyOfflineTitle")}</p>
      <p className="mb-4 text-body-sm text-muted-foreground">{online ? t("bodyErrorDescription") : t("bodyOfflineDescription")}</p>
      <div className="flex flex-wrap justify-center gap-2">
        <Button onClick={error.retry} disabled={error.retrying} aria-busy={error.retrying || undefined}>
          <RotateCw className={error.retrying ? "animate-spin" : undefined} />
          {t("retry")}
        </Button>
        {hasLink && online && (
          <Button onClick={onOpenOriginal} variant="outline">
            <ExternalLink />
            {t("openOriginal")}
          </Button>
        )}
      </div>
    </div>
  );
}

function AiSummaryCard({ article }: { article: Article }) {
  const t = useTranslations("articleReader");
  const { data: aiSettings } = useAiSettings();
  const summarize = useSummarizeArticle();
  const [localSummary, setLocalSummary] = useState<string | null>(null);
  // false | "error" (provider failed) | "budget" (daily token cap) | "ai_off" (cap 0)
  const [failed, setFailed] = useState<false | "error" | "budget" | "ai_off">(false);
  const id = article.id;

  useEffect(() => {
    setLocalSummary(null);
    setFailed(false);
  }, [id]);

  const run = useCallback(async () => {
    setFailed(false);
    try {
      const result = await summarize.mutateAsync(id);
      if (result.error) setFailed(result.error);
      else setLocalSummary(result.summary);
    } catch {
      // The toast comes from useSummarizeArticle's onError; this drives the inline hint.
      setFailed("error");
    }
  }, [summarize, id]);

  const enabled = Boolean(aiSettings?.provider);
  useEffect(() => {
    if (!enabled) return;
    const onRequest = (e: Event) => {
      if ((e as CustomEvent<{ id: string }>).detail?.id !== id) return;
      document.getElementById("reader-ai-summary")?.scrollIntoView({ block: "nearest" });
      void run();
    };
    window.addEventListener(SUMMARIZE_EVENT, onRequest);
    return () => window.removeEventListener(SUMMARIZE_EVENT, onRequest);
  }, [enabled, id, run]);

  if (!enabled) return null;
  const summary = localSummary ?? article.aiSummary;
  return (
    <section id="reader-ai-summary" aria-label={t("aiSummary")} className="ff-reader-card ff-reader-card-accent mb-8">
      <div className="flex min-w-0 items-center justify-between gap-3">
        <h2 className="flex min-w-0 items-center gap-2 text-footnote uppercase tracking-overline text-muted-foreground">
          <Sparkles className="size-3.5 shrink-0 text-brand" />
          <span className="truncate">{t("aiSummary")}</span>
        </h2>
        <Button variant="ghost" size="sm" className="shrink-0 text-muted-foreground" disabled={summarize.isPending} onClick={() => void run()}>
          {summarize.isPending ? t("summarizing") : summary ? t("regenerate") : t("summarize")}
        </Button>
      </div>
      {summary ? (
        <p className="mt-2 text-body-sm text-foreground/80">{summary}</p>
      ) : failed ? (
        <p className="mt-2 text-body-sm text-destructive" role="status">
          {failed === "budget" ? t("summarizeBudget") : failed === "ai_off" ? t("summarizeAiOff") : t("summarizeFailedInline")}
        </p>
      ) : (
        <p className="mt-2 text-body-sm italic text-muted-foreground">{t("aiSummaryHint")}</p>
      )}
    </section>
  );
}
