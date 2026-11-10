"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import type { BriefingContent, BriefingErrorCode, BriefingEvent, BriefingResponse, FallbackReason } from "@/lib/briefing/types";
import { briefingKey, streamBriefing } from "./api";

export interface BriefingStreamState {
  status: "idle" | "streaming" | "done" | "error";
  /** Items validated so far (AI mode) while streaming. */
  content: BriefingContent | null;
  error: BriefingErrorCode | null;
  fallbackReason: FallbackReason | null;
}

const IDLE: BriefingStreamState = { status: "idle", content: null, error: null, fallbackReason: null };

function emptyContent(storyCount: number, window?: { start: string; end: string }): BriefingContent {
  return { mode: "ai", what: [], why: [], brief: [], dropped: 0, storyCount, window: window ?? { start: "", end: "" } };
}

/**
 * Runs one POST generation and mirrors its validated events into local state;
 * the final result (AI content or fallback) is written into the
 * `["briefing", scopeKey]` query cache, so a remount shows it instantly.
 */
export function useBriefingStream(scopeKey: string) {
  const qc = useQueryClient();
  const [state, setState] = useState<BriefingStreamState>(IDLE);
  const abortRef = useRef<AbortController | null>(null);

  useEffect(() => () => abortRef.current?.abort(), []);

  const start = useCallback(
    async (o: { force?: boolean } = {}) => {
      if (abortRef.current) return;
      const controller = new AbortController();
      abortRef.current = controller;
      let content: BriefingContent | null = null;
      let error: BriefingErrorCode | null = null;
      let stale: { newStories: number } | null = null;
      setState({ ...IDLE, status: "streaming" });
      const patchCache = (patch: Partial<BriefingResponse>) =>
        qc.setQueryData<BriefingResponse>(briefingKey(scopeKey), (prev) => (prev ? { ...prev, ...patch } : prev));
      const onEvent = (event: BriefingEvent) => {
        switch (event.type) {
          case "meta":
            stale = event.stale ?? null;
            content = emptyContent(event.storyCount, event.window);
            setState((s) => ({ ...s, content }));
            break;
          case "item": {
            const base: BriefingContent = content ?? emptyContent(0);
            content = { ...base, [event.section]: [...base[event.section], event.item] };
            setState((s) => ({ ...s, content }));
            break;
          }
          case "dropped":
            if (content) content = { ...content, dropped: event.count };
            break;
          case "done":
            if (content) {
              patchCache({
                briefing: content,
                briefingId: event.briefingId,
                generatedAt: event.generatedAt,
                stale,
                seen: false,
                fallbackReason: null,
              });
            }
            setState({ status: "done", content, error, fallbackReason: null });
            break;
          case "fallback":
            patchCache({ briefing: event.briefing, briefingId: null, fallbackReason: event.reason, stale: null });
            setState({ status: error ? "error" : "done", content: null, error, fallbackReason: event.reason });
            break;
          case "error":
            error = event.code;
            setState((s) => ({ ...s, error: event.code }));
            break;
        }
      };
      try {
        await streamBriefing(scopeKey, { force: o.force, signal: controller.signal }, onEvent);
        setState((s) => (s.status === "streaming" ? { ...s, status: error ? "error" : "done" } : s));
      } catch {
        if (!controller.signal.aborted) setState((s) => ({ ...s, status: "error", error: s.error ?? "provider_down" }));
      } finally {
        if (abortRef.current === controller) abortRef.current = null;
      }
    },
    [qc, scopeKey],
  );

  return { state, start };
}
