// One discovery run's shared limits: a wall-clock deadline (in-flight
// requests are aborted through one AbortSignal), a request budget counted
// across every stage (resolver lookups, RSSHub validations, page fetch,
// candidate verification, transport retries and redirect hops), and per-host
// rate-limit blocks so a 429 stops all further probes of that host — for both
// transports, for the rest of this run and, via the shared per-host backoff
// (lib/host-backoff.ts, also used by full text), for the server's Retry-After
// window across runs.

import { classifyFetchFailure, hostRateLimitRemainingMs, recordHostFailure } from "./host-backoff";

export const DISCOVERY_DEADLINE_MS = 25_000;
export const DISCOVERY_MAX_REQUESTS = 30;
/** Per-request ceiling; a request never outlives the run's deadline either. */
export const DISCOVERY_REQUEST_TIMEOUT_MS = 12_000;

export type DiscoveryStopReason = "deadline" | "request-budget";

function hostOf(url: string): string | null {
  try {
    return new URL(url).hostname.toLowerCase();
  } catch {
    return null;
  }
}

/** 429, or any refusal that told us when to come back (Retry-After): never retried, the host is blocked. */
export function isRateLimitResponse(err: unknown): boolean {
  const { kind, retryAfterMs } = classifyFetchFailure(err);
  return kind === "rate_limited" || retryAfterMs !== null;
}

export class DiscoveryBudget {
  readonly signal: AbortSignal;
  private readonly controller = new AbortController();
  private readonly deadlineAt: number;
  private readonly timer: ReturnType<typeof setTimeout>;
  private used = 0;
  private stop: DiscoveryStopReason | null = null;
  private readonly blockedHosts = new Set<string>();
  /** Transport that last worked per host in this run (true = browser-like impit). */
  private readonly workingTransport = new Map<string, boolean>();

  constructor(
    readonly limits: { deadlineMs: number; maxRequests: number } = {
      deadlineMs: DISCOVERY_DEADLINE_MS,
      maxRequests: DISCOVERY_MAX_REQUESTS,
    },
  ) {
    this.signal = this.controller.signal;
    this.deadlineAt = Date.now() + limits.deadlineMs;
    this.timer = setTimeout(() => {
      this.stop ??= "deadline";
      this.controller.abort(new Error("Discovery deadline reached"));
    }, limits.deadlineMs);
    // Never keep the process alive for a finished run.
    (this.timer as { unref?: () => void }).unref?.();
  }

  get requestsUsed(): number {
    return this.used;
  }

  /** Why the run stopped early (partial results), or null. */
  get stopReason(): DiscoveryStopReason | null {
    return this.stop;
  }

  remainingMs(): number {
    return Math.max(0, this.deadlineAt - Date.now());
  }

  /** Per-request timeout: the usual ceiling, but never past the run's deadline. */
  requestTimeoutMs(): number {
    return Math.max(1, Math.min(DISCOVERY_REQUEST_TIMEOUT_MS, this.remainingMs()));
  }

  isHostBlocked(url: string): boolean {
    const host = hostOf(url);
    if (!host) return false;
    return this.blockedHosts.has(host) || hostRateLimitRemainingMs(url) > 0;
  }

  /**
   * Claims one request to `url` (a first attempt, a transport retry or a
   * redirect hop). False when the deadline passed, the budget is spent, or the
   * host is rate-limit blocked — the caller must not send it.
   */
  take(url: string): boolean {
    if (this.signal.aborted || this.remainingMs() <= 0) {
      this.stop ??= "deadline";
      return false;
    }
    if (this.isHostBlocked(url)) return false;
    if (this.used >= this.limits.maxRequests) {
      this.stop ??= "request-budget";
      return false;
    }
    this.used++;
    return true;
  }

  /**
   * Records a failed request at the URL that actually answered (the final
   * redirect hop). A rate-limit response blocks its host for this run (both
   * transports) and is written to the shared host backoff ONCE per host per
   * run — parallel 429s from one batch must not inflate the exponential
   * backoff that full-text syncs honour too.
   */
  noteFailure(url: string, err: unknown): void {
    if (!isRateLimitResponse(err)) return;
    const host = hostOf(url);
    if (!host || this.blockedHosts.has(host)) return;
    this.blockedHosts.add(host);
    recordHostFailure(url, err);
  }

  /** The transport that worked for this host earlier in the run, if any. */
  preferredImpersonate(url: string): boolean | undefined {
    const host = hostOf(url);
    return host ? this.workingTransport.get(host) : undefined;
  }

  noteWorkingTransport(url: string, impersonate: boolean): void {
    const host = hostOf(url);
    if (host) this.workingTransport.set(host, impersonate);
  }

  /**
   * Per-request redirect accounting: every hop claims budget (and may not go
   * to a blocked host); `finalUrl()` is the last URL the request reached.
   */
  track(url: string): { redirectGuard: (next: string) => string | null; finalUrl: () => string } {
    let final = url;
    return {
      redirectGuard: (next: string) => {
        if (!this.take(next)) return null;
        final = next;
        return next;
      },
      finalUrl: () => final,
    };
  }

  dispose(): void {
    clearTimeout(this.timer);
  }
}

/** Error thrown instead of sending a request the budget refused. */
export class DiscoveryBudgetRefusal extends Error {
  constructor(url: string) {
    let host = "host";
    try {
      host = new URL(url).hostname;
    } catch {
      // keep generic
    }
    super(`Discovery skipped ${host}: budget, deadline or rate-limit block`);
    this.name = "DiscoveryBudgetRefusal";
  }
}
