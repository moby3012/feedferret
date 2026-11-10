"use client";

import { useCallback, useEffect, useId, useMemo, useRef, useState } from "react";
import { useFormatter, useTranslations } from "next-intl";
import { useQueryClient } from "@tanstack/react-query";
import { ChevronDown, Sparkles, Square, Volume2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { postBriefingSeen, briefingKey } from "@/features/briefing/api";
import { useBriefing } from "@/features/briefing/queries";
import { useBriefingStream } from "@/features/briefing/use-briefing-stream";
import { readUiPrefsFromDocument, writeUiPrefs } from "@/features/reader/layout/ui-prefs";
import { nav } from "@/features/reader/nav/store";
import type { BriefingContent, BriefingResponse } from "@/lib/briefing/types";
import { cn } from "@/lib/utils";
import { BriefingSection } from "./briefing-section";

const SEEN_AFTER_MS = 5_000;
const TOP_SLOP_PX = 8;

function initialExpanded(): boolean {
  if (typeof document === "undefined") return true;
  try {
    return readUiPrefsFromDocument().bc !== 1;
  } catch {
    return true;
  }
}

/**
 * K2 "catch me up" hero card at the top of the Neu list (inside the list
 * scroller, not sticky). Self-contained: owns its query, the generation
 * stream, collapse state (`ff_ui` cookie `bc`) and the seen signal. Model
 * text arrives validated from the server and is rendered as plain text plus
 * citation chips; a chip opens the cited article via the nav store.
 */
export function BriefingCard({ scopeKey = "new", active = true }: { scopeKey?: string; active?: boolean }) {
  const t = useTranslations("briefing");
  const format = useFormatter();
  const qc = useQueryClient();
  const query = useBriefing(scopeKey, true);
  const data = query.data;
  const { state, start } = useBriefingStream(scopeKey);
  const [expanded, setExpanded] = useState(initialExpanded);
  const [capped, setCapped] = useState(false);
  const [speaking, setSpeaking] = useState(false);
  const rootRef = useRef<HTMLElement | null>(null);
  const autoStarted = useRef(false);
  const uid = useId();
  const headingId = `briefing-h-${uid}`;
  const bodyId = `briefing-b-${uid}`;

  const streaming = state.status === "streaming";
  const streamed = streaming && state.content && state.content.what.length + state.content.why.length + state.content.brief.length > 0 ? state.content : null;
  const content: BriefingContent | null = streamed ?? (streaming ? null : (data?.briefing ?? null));
  const isAi = content?.mode === "ai";

  // Citation numbers: order of first appearance across the whole card.
  const indexOf = useMemo(() => {
    const map = new Map<string, number>();
    if (content) for (const item of [...content.what, ...content.why, ...content.brief]) for (const c of item.citations) if (!map.has(c.articleId)) map.set(c.articleId, map.size + 1);
    return (id: string) => map.get(id) ?? 0;
  }, [content]);

  const markSeen = useCallback(() => {
    const id = data?.briefingId;
    if (!id || data?.seen) return;
    qc.setQueryData<BriefingResponse>(briefingKey(scopeKey), (prev) => (prev ? { ...prev, seen: true } : prev));
    void postBriefingSeen(id);
  }, [data?.briefingId, data?.seen, qc, scopeKey]);

  const setOpen = (open: boolean) => {
    setExpanded(open);
    try {
      writeUiPrefs({ bc: open ? 0 : 1 });
    } catch {
      /* cookie blocked: session-only */
    }
  };

  const generate = useCallback(
    (force = false) => {
      setCapped(true);
      void start({ force });
    },
    [start],
  );

  // Auto-generation (local provider + setting): only when expanded, active and visible.
  useEffect(() => {
    if (!data?.auto || !expanded || !active || autoStarted.current || streaming) return;
    if (data.briefing?.mode === "ai" && !data.stale) return;
    if (typeof document !== "undefined" && document.visibilityState !== "visible") return;
    autoStarted.current = true;
    generate(false);
  }, [data?.auto, data?.briefing?.mode, data?.stale, expanded, active, streaming, generate]);

  // Done streaming: release the height cap only when the list sits at the top
  // (rows never move under the finger); otherwise "Mehr anzeigen" stays.
  useEffect(() => {
    if (streaming || !capped) return;
    const scroller = rootRef.current?.closest<HTMLElement>('[data-testid="list-scroller"]');
    if (!scroller || scroller.scrollTop < TOP_SLOP_PX) setCapped(false);
  }, [streaming, capped]);

  // Seen: expanded and ≥ 50 % visible for 5 s.
  useEffect(() => {
    const el = rootRef.current;
    if (!el || !expanded || !active || !data?.briefingId || data.seen || streaming || typeof IntersectionObserver === "undefined") return;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const io = new IntersectionObserver(
      ([entry]) => {
        if (entry.intersectionRatio >= 0.5) timer ??= setTimeout(markSeen, SEEN_AFTER_MS);
        else if (timer) {
          clearTimeout(timer);
          timer = null;
        }
      },
      { threshold: [0, 0.5, 1] },
    );
    io.observe(el);
    return () => {
      io.disconnect();
      if (timer) clearTimeout(timer);
    };
  }, [expanded, active, data?.briefingId, data?.seen, streaming, markSeen]);

  useEffect(() => () => (typeof window !== "undefined" && window.speechSynthesis ? window.speechSynthesis.cancel() : undefined), []);

  const openCitation = useCallback(
    (articleId: string) => {
      markSeen();
      void nav.openArticle(articleId);
    },
    [markSeen],
  );

  if (!data || data.totalUnread === 0 || !content && !streaming) return null;

  const canSpeak = typeof window !== "undefined" && "speechSynthesis" in window;
  const toggleSpeech = () => {
    const synth = window.speechSynthesis;
    if (speaking) {
      synth.cancel();
      setSpeaking(false);
      return;
    }
    if (!content) return;
    const text = [...content.what, ...content.why, ...content.brief].map((i) => i.text).join(". ");
    const utterance = new SpeechSynthesisUtterance(text);
    utterance.lang = data.lang;
    utterance.onend = () => setSpeaking(false);
    utterance.onerror = () => setSpeaking(false);
    synth.cancel();
    synth.speak(utterance);
    setSpeaking(true);
  };

  // Header meta reads the last known content while a generation starts (no reflow).
  const metaContent = content ?? data.briefing;
  const since = metaContent?.window.start ? new Date(metaContent.window.start) : null;
  const sinceText = since && !Number.isNaN(since.getTime())
    ? format.dateTime(since, Date.now() - since.getTime() > 20 * 3_600_000 ? { weekday: "short", hour: "2-digit", minute: "2-digit" } : { hour: "2-digit", minute: "2-digit" })
    : "";
  const storyCount = metaContent?.storyCount ?? 0;
  const tooFew = data.fallbackReason === "too_few" && !isAi;
  const reason = streaming ? null : state.fallbackReason ?? (isAi ? null : data.fallbackReason);
  const errorCode = state.error ?? (reason === "budget" ? "budget" : null);
  const itemCount = content ? content.what.length + content.why.length + content.brief.length : 0;
  const status = streaming
    ? t("generating")
    : state.status === "done" && isAi
      ? t("done", { count: itemCount })
      : errorCode
        ? t(`error.${errorCode}`)
        : "";
  const canGenerate = data.ai === "ready" && !tooFew && !streaming && (!isAi || !!data.stale || !!state.error);

  return (
    <section
      ref={rootRef}
      data-testid="briefing-card"
      data-mode={content?.mode ?? "ai"}
      data-state={streaming ? "generating" : expanded ? "expanded" : "collapsed"}
      aria-labelledby={headingId}
      aria-busy={streaming || undefined}
      className="col-span-full rounded-row border border-border/60 bg-surface-raised text-foreground"
    >
      <h3 id={headingId} className="m-0">
        <button
          type="button"
          aria-expanded={expanded}
          aria-controls={bodyId}
          onClick={() => setOpen(!expanded)}
          className="flex min-h-14 w-full items-center gap-2.5 rounded-row px-4 py-2 text-start focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        >
          <Sparkles className="size-4 shrink-0 text-primary" aria-hidden="true" />
          <span className="flex min-w-0 flex-1 flex-col">
            <span className="text-title-sm">{isAi || streaming ? t("title") : t("titleHeadlines")}</span>
            <span className="text-footnote text-muted-foreground">{tooFew ? t("tooFew", { count: storyCount }) : t("meta", { count: storyCount, time: sinceText })}</span>
          </span>
          <ChevronDown className={cn("size-4 shrink-0 text-muted-foreground transition-transform duration-(--dur-fast) motion-reduce:transition-none", expanded && "rotate-180")} aria-hidden="true" />
        </button>
      </h3>
      <p role="status" aria-live="polite" className="sr-only">
        {status}
      </p>
      {expanded && (
        <div id={bodyId} className="flex flex-col gap-3 px-4 pb-4">
          <div className={cn("relative flex flex-col gap-3", capped && "h-[60vh] overflow-hidden")} data-testid="briefing-body">
            {streaming && !streamed ? (
              <div className="flex flex-col gap-2.5 py-1" aria-hidden="true">
                {[92, 80, 86, 64, 72].map((w) => (
                  <div key={w} className="h-4 animate-pulse rounded-chip bg-muted motion-reduce:animate-none" style={{ width: `${w}%` }} />
                ))}
              </div>
            ) : (
              content && (
                <>
                  <BriefingSection id="what" heading={isAi ? t("what") : t("headlines")} items={content.what} emphasis indexOf={indexOf} onOpen={openCitation} />
                  <BriefingSection id="why" heading={t("why")} items={content.why} indexOf={indexOf} onOpen={openCitation} />
                  <BriefingSection id="brief" heading={t("brief")} items={content.brief} indexOf={indexOf} onOpen={openCitation} />
                </>
              )
            )}
            {capped && !streaming && (
              <div className="absolute inset-x-0 bottom-0 flex justify-center bg-gradient-to-t from-surface-raised via-surface-raised/90 to-transparent pt-10 pb-1">
                <Button type="button" variant="outline" size="sm" className="rounded-control" onClick={() => setCapped(false)}>
                  {t("showMore")}
                </Button>
              </div>
            )}
          </div>
          {data.stale && isAi && !streaming && <p className="text-footnote text-muted-foreground">{t("staleNote", { count: data.stale.newStories })}</p>}
          {reason && reason !== "too_few" && !isAi && <p className="text-footnote text-muted-foreground" data-testid="briefing-fallback-reason">{t(`fallback.${reason}`)}</p>}
          {state.error && !streaming && <p className="text-footnote text-danger" data-testid="briefing-error">{t(`error.${state.error}`)}</p>}
          {/* min-h: the row exists while streaming, so buttons appearing on "done" never shift the list */}
          <div className="flex min-h-8 flex-wrap items-center gap-2">
            {data.briefingId && isAi && !streaming && (
              <Button
                type="button"
                variant="outline"
                size="sm"
                className="rounded-control"
                onClick={() => {
                  markSeen();
                  setOpen(false);
                }}
              >
                {t("seen")}
              </Button>
            )}
            {canGenerate && (
              <Button type="button" size="sm" className="rounded-control" onClick={() => generate(isAi)}>
                <Sparkles className="size-3.5" aria-hidden="true" />
                {state.error ? t("retry") : isAi ? t("refresh") : t("generate")}
              </Button>
            )}
            {canSpeak && content && !streaming && (
              <Button type="button" variant="ghost" size="sm" className="rounded-control" aria-pressed={speaking} onClick={toggleSpeech}>
                {speaking ? <Square className="size-3.5" aria-hidden="true" /> : <Volume2 className="size-3.5" aria-hidden="true" />}
                {speaking ? t("stop") : t("listen")}
              </Button>
            )}
          </div>
          <p className="text-caption text-muted-foreground">{(isAi || streaming) && data.model ? t("privacyNote", { model: data.model }) : t("headlinesNote")}</p>
        </div>
      )}
    </section>
  );
}
