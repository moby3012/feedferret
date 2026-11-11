"use client";

import { useCallback, useEffect, useId, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { useFormatter, useTranslations } from "next-intl";
import { useQueryClient } from "@tanstack/react-query";
import { ChevronDown, Sparkles, Square, Volume2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { postBriefingSeen, briefingKey } from "@/features/briefing/api";
import { useBriefing } from "@/features/briefing/queries";
import { useBriefingStream } from "@/features/briefing/use-briefing-stream";
import { updateUiPrefs, useUiPrefs } from "@/features/reader/layout/ui-prefs-context";
import { nav } from "@/features/reader/nav/store";
import type { BriefingContent, BriefingResponse } from "@/lib/briefing/types";
import { cn } from "@/lib/utils";
import { BriefingSection } from "./briefing-section";

const SEEN_AFTER_MS = 5_000;
const noopSubscribe = () => () => {};
const hasSpeech = () => "speechSynthesis" in window;
const noSpeech = () => false;
const TOP_SLOP_PX = 8;

/**
 * K2 "catch me up" hero card at the top of the Neu list (inside the list
 * scroller, not sticky). Self-contained: owns its query, the generation
 * stream, collapse state (`ff_ui` cookie `bc`, via the page's UI prefs) and the seen signal. Model
 * text arrives validated from the server and is rendered as plain text plus
 * citation chips; a chip opens the cited article via the nav store.
 *
 * Layout contract (rows never move without a user action): the card mounts
 * together with the first rows and always renders a fixed-height header
 * (title + one status line: loading / "Erstellen" / "wird erstellt…" /
 * "Neu: N Geschichten" / summary). The body below it opens on its own only
 * when the briefing was already loaded when the card mounted (so it is part of
 * the first paint). Otherwise it stays collapsed for this mount until the user
 * opens it. The body renders a pinned snapshot of the briefing (taken at mount
 * and on every user action), so a later refetch or a background
 * auto-generation (local providers) only updates the header status line.
 */
export function BriefingCard({ scopeKey = "new", active = true }: { scopeKey?: string; active?: boolean }) {
  const t = useTranslations("briefing");
  const format = useFormatter();
  const qc = useQueryClient();
  const query = useBriefing(scopeKey, true);
  const data = query.data;
  const { state, start } = useBriefingStream(scopeKey);
  const uiPrefs = useUiPrefs();
  // Opens by itself only when the content is part of the first paint (server-
  // prefetched on a cold start) and the user did not collapse it (`ff_ui.bc`,
  // parsed on the server, so SSR and hydration agree).
  const [expanded, setExpanded] = useState(() => !!data && uiPrefs.current.bc !== 1);
  // What the body renders; replaced only at mount and on user actions.
  const [pinned, setPinned] = useState<BriefingResponse | null>(data ?? null);
  // The body follows the stream only for a generation the user started.
  const [userGen, setUserGen] = useState(false);
  const [capped, setCapped] = useState(false);
  const [speaking, setSpeaking] = useState(false);
  const rootRef = useRef<HTMLElement | null>(null);
  const autoStarted = useRef(false);
  const uid = useId();
  const headingId = `briefing-h-${uid}`;
  const bodyId = `briefing-b-${uid}`;

  const streaming = state.status === "streaming";
  // After a user-started generation the body shows its result (written to the cache).
  const bodyData = userGen ? data : pinned;
  const bodyStreaming = userGen && streaming;
  const streamed = bodyStreaming && state.content && state.content.what.length + state.content.why.length + state.content.brief.length > 0 ? state.content : null;
  const content: BriefingContent | null = streamed ?? (bodyStreaming ? null : (bodyData?.briefing ?? null));
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
    if (open && !userGen) setPinned(qc.getQueryData<BriefingResponse>(briefingKey(scopeKey)) ?? data ?? null);
    setExpanded(open);
    updateUiPrefs(uiPrefs, { bc: open ? 0 : 1 });
  };

  /** Explicit "Erstellen" / "Aktualisieren": the body opens and follows the stream (height-capped). */
  const generate = (force = false) => {
    autoStarted.current = true;
    setUserGen(true);
    setCapped(true);
    setOpen(true);
    void start({ force });
  };

  // Auto-generation (local provider + setting) when the pane is active and
  // visible. It streams into the header status line only; the body keeps its
  // pinned snapshot until the user opens / refreshes it.
  useEffect(() => {
    if (!data?.auto || !active || autoStarted.current || streaming) return;
    if (data.briefing?.mode === "ai" && !data.stale) return;
    if (typeof document !== "undefined" && document.visibilityState !== "visible") return;
    autoStarted.current = true;
    void start({ force: false });
  }, [data?.auto, data?.briefing?.mode, data?.stale, active, streaming, start]);

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

  // The body can be server-rendered (bootstrap-prefetched briefing): false on
  // the server and during hydration, then the browser's answer.
  const canSpeak = useSyncExternalStore(noopSubscribe, hasSpeech, noSpeech);
  const toggleSpeech = () => {
    const synth = window.speechSynthesis;
    if (speaking) {
      synth.cancel();
      setSpeaking(false);
      return;
    }
    if (!content || !bodyData) return;
    const text = [...content.what, ...content.why, ...content.brief].map((i) => i.text).join(". ");
    const utterance = new SpeechSynthesisUtterance(text);
    utterance.lang = bodyData.lang;
    utterance.onend = () => setSpeaking(false);
    utterance.onerror = () => setSpeaking(false);
    synth.cancel();
    synth.speak(utterance);
    setSpeaking(true);
  };

  const sinceOf = (c: BriefingContent | null | undefined) => {
    const since = c?.window.start ? new Date(c.window.start) : null;
    return since && !Number.isNaN(since.getTime())
      ? format.dateTime(since, Date.now() - since.getTime() > 20 * 3_600_000 ? { weekday: "short", hour: "2-digit", minute: "2-digit" } : { hour: "2-digit", minute: "2-digit" })
      : "";
  };

  // ── Header: live state, one fixed-height line set ──
  const liveAi = data?.briefing?.mode === "ai";
  const liveTooFew = data?.fallbackReason === "too_few" && !liveAi;
  const liveCount = data?.briefing?.storyCount ?? 0;
  const liveItems = state.content ? state.content.what.length + state.content.why.length + state.content.brief.length : 0;
  const canGenerateLive = !!data && data.ai === "ready" && data.totalUnread > 0 && !liveTooFew && !streaming && (!liveAi || !!data.stale || !!state.error);
  // A background (auto) result the pinned body does not show yet.
  const unseenResult = !userGen && expanded && !streaming && !!data?.briefing && data.briefing !== pinned?.briefing;
  const title = !data ? t("heading") : liveAi || (streaming && data.ai === "ready") ? t("title") : t("titleHeadlines");
  let statusLine: string;
  if (!data) statusLine = t("loading");
  else if (streaming) statusLine = t("generating");
  else if (data.totalUnread === 0) statusLine = t("none");
  else if (state.error && !userGen) statusLine = t(`error.${state.error}`);
  else if (state.status === "done" && !userGen && liveAi) statusLine = t("done", { count: liveItems });
  else if (data.stale) statusLine = t("newStories", { count: data.stale.newStories });
  else if (liveTooFew) statusLine = t("tooFew", { count: liveCount });
  else statusLine = t("meta", { count: liveCount, time: sinceOf(data.briefing) });
  const headerAction = unseenResult
    ? { label: t("show"), run: () => setOpen(true) }
    : !expanded && canGenerateLive
      ? { label: liveAi ? t("refresh") : t("create"), run: () => generate(liveAi) }
      : null;

  // ── Body: pinned snapshot (or the user's own generation) ──
  const tooFew = bodyData?.fallbackReason === "too_few" && !isAi;
  const bodyState = userGen ? state : null;
  const reason = bodyStreaming ? null : bodyState?.fallbackReason ?? (isAi ? null : bodyData?.fallbackReason ?? null);
  const errorCode = (streaming ? state.error : null) ?? bodyState?.error ?? (reason === "budget" ? "budget" : null);
  const status = streaming
    ? t("generating")
    : state.status === "done" && (isAi || liveAi)
      ? t("done", { count: liveItems })
      : errorCode
        ? t(`error.${errorCode}`)
        : "";
  const canGenerate = !!bodyData && bodyData.ai === "ready" && !tooFew && !streaming && (!isAi || !!bodyData.stale || !!bodyState?.error);
  const showBody = expanded && (!!content || bodyStreaming);

  return (
    <section
      ref={rootRef}
      data-testid="briefing-card"
      data-mode={content?.mode ?? (liveAi ? "ai" : data ? "headlines" : "pending")}
      data-state={streaming ? "generating" : expanded ? "expanded" : "collapsed"}
      aria-labelledby={headingId}
      aria-busy={streaming || undefined}
      className="col-span-full rounded-row border border-border/60 bg-surface-raised text-foreground"
    >
      {/* Fixed height (h-14): the header never changes the card's height. */}
      <div className="flex h-14 items-center gap-1 pe-2" data-testid="briefing-header">
        <h3 id={headingId} className="m-0 h-full min-w-0 flex-1">
          <button
            type="button"
            aria-expanded={expanded}
            aria-controls={bodyId}
            onClick={() => setOpen(!expanded)}
            className="flex h-full w-full items-center gap-2.5 rounded-row ps-4 pe-2 text-start focus-ring"
          >
            <Sparkles className="size-4 shrink-0 text-primary" aria-hidden="true" />
            <span className="flex min-w-0 flex-1 flex-col">
              <span className="truncate text-title-sm">{title}</span>
              <span className="truncate text-footnote text-muted-foreground" data-testid="briefing-status-line">
                {statusLine}
              </span>
            </span>
            <ChevronDown className={cn("size-4 shrink-0 text-muted-foreground transition-transform duration-(--dur-fast) motion-reduce:transition-none", expanded && "rotate-180")} aria-hidden="true" />
          </button>
        </h3>
        {headerAction && (
          <Button type="button" size="sm" variant="outline" className="shrink-0 rounded-control" onClick={headerAction.run} data-testid="briefing-header-action">
            {headerAction.label}
          </Button>
        )}
      </div>
      <p role="status" aria-live="polite" className="sr-only">
        {status}
      </p>
      {showBody && bodyData && (
        <div id={bodyId} className="flex flex-col gap-3 px-4 pb-4">
          <div className={cn("relative flex flex-col gap-3", capped && "h-[60vh] overflow-hidden")} data-testid="briefing-body">
            {bodyStreaming && !streamed ? (
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
          {bodyData.stale && isAi && !bodyStreaming && <p className="text-footnote text-muted-foreground">{t("staleNote", { count: bodyData.stale.newStories })}</p>}
          {reason && reason !== "too_few" && !isAi && <p className="text-footnote text-muted-foreground" data-testid="briefing-fallback-reason">{t(`fallback.${reason}`)}</p>}
          {bodyState?.error && !streaming && <p className="text-footnote text-danger" data-testid="briefing-error">{t(`error.${bodyState.error}`)}</p>}
          {/* min-h: the row exists while streaming, so buttons appearing on "done" never shift the list */}
          <div className="flex min-h-8 flex-wrap items-center gap-2">
            {bodyData.briefingId && isAi && !bodyStreaming && (
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
                {bodyState?.error ? t("retry") : isAi ? t("refresh") : t("generate")}
              </Button>
            )}
            {canSpeak && content && !bodyStreaming && (
              <Button type="button" variant="ghost" size="sm" className="rounded-control" aria-pressed={speaking} onClick={toggleSpeech}>
                {speaking ? <Square className="size-3.5" aria-hidden="true" /> : <Volume2 className="size-3.5" aria-hidden="true" />}
                {speaking ? t("stop") : t("listen")}
              </Button>
            )}
          </div>
          <p className="text-caption text-muted-foreground">{(isAi || bodyStreaming) && bodyData.model ? t("privacyNote", { model: bodyData.model }) : t("headlinesNote")}</p>
        </div>
      )}
    </section>
  );
}
