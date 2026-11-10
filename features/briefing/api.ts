import { ApiError, getJson } from "@/features/articles/api";
import type { BriefingEvent, BriefingResponse } from "@/lib/briefing/types";

export const briefingKey = (scopeKey: string) => ["briefing", scopeKey] as const;

export function fetchBriefing(scopeKey: string, signal?: AbortSignal): Promise<BriefingResponse> {
  return getJson<BriefingResponse>(`/api/app/briefing?scope=${encodeURIComponent(scopeKey)}`, signal);
}

/** POST → NDJSON events, delivered one by one to `onEvent`. Resolves when the stream ends. */
export async function streamBriefing(scopeKey: string, o: { force?: boolean; signal?: AbortSignal }, onEvent: (event: BriefingEvent) => void): Promise<void> {
  const params = new URLSearchParams({ scope: scopeKey });
  if (o.force) params.set("force", "1");
  const res = await fetch(`/api/app/briefing?${params.toString()}`, {
    method: "POST",
    credentials: "same-origin",
    headers: { accept: "application/x-ndjson" },
    cache: "no-store",
    signal: o.signal,
  });
  if (!res.ok || !res.body) throw new ApiError(res.status, `Request failed (${res.status})`);
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  const flush = (line: string) => {
    if (!line.trim()) return;
    try {
      onEvent(JSON.parse(line) as BriefingEvent);
    } catch {
      /* malformed line: ignore */
    }
  };
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    let nl = buffer.indexOf("\n");
    while (nl !== -1) {
      flush(buffer.slice(0, nl));
      buffer = buffer.slice(nl + 1);
      nl = buffer.indexOf("\n");
    }
  }
  flush(buffer + decoder.decode());
}

export async function postBriefingSeen(briefingId: string): Promise<void> {
  await fetch("/api/app/briefing/seen", {
    method: "POST",
    credentials: "same-origin",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ briefingId }),
  }).catch(() => {});
}
