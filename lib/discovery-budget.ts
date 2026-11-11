// One discovery run's shared limits: a wall-clock deadline (in-flight
// requests are aborted through one AbortSignal), a request budget counted
// across every stage (resolver lookups, RSSHub validations, page fetch,
// candidate verification, transport retries and redirect hops), and per-host
// rate-limit blocks so a 429 stops all further probes of that host — for both
// transports, for the rest of this run and for the server's Retry-After window.
//
// TODO(P-PLAT/#275): unify the host block with lib/host-backoff.ts once the
// full-text PR lands (its HttpStatusError carries `retryAfterMs`, which
// `retryAfterMsOf` below already reads; on main today the SSRF error has no
// Retry-After, so the default window applies).

export const DISCOVERY_DEADLINE_MS = 25_000;
export const DISCOVERY_MAX_REQUESTS = 30;
/** Per-request ceiling; a request never outlives the run's deadline either. */
export const DISCOVERY_REQUEST_TIMEOUT_MS = 12_000;
/** 429 without a (readable) Retry-After. */
const DEFAULT_RATE_LIMIT_BLOCK_MS = 60_000;
/** Sanity cap for a server's Retry-After (discovery only needs "not now"). */
const MAX_BLOCK_MS = 60 * 60 * 1000;
const MAX_TRACKED_HOSTS = 1_000;

export type DiscoveryStopReason = "deadline" | "request-budget";

/** In-process Retry-After windows, shared by discovery runs (and both transports). */
const rateLimitedUntil = new Map<string, number>();

function hostOf(url: string): string | null {
  try {
    return new URL(url).hostname.toLowerCase();
  } catch {
    return null;
  }
}

function statusOf(err: unknown): number | null {
  const typed = (err as { status?: unknown } | null)?.status;
  if (typeof typed === "number") return typed;
  const m = /^Fetch failed: (\d{3})\b/.exec(err instanceof Error ? err.message : String(err ?? ""));
  return m ? Number(m[1]) : null;
}

/** Retry-After carried by the fetch error (lib/ssrf HttpStatusError after #275), in ms. */
export function retryAfterMsOf(err: unknown): number | null {
  const v = (err as { retryAfterMs?: unknown } | null)?.retryAfterMs;
  return typeof v === "number" && Number.isFinite(v) && v >= 0 ? v : null;
}

/** 429, or any refusal that told us when to come back: never retried, the host is blocked. */
export function isRateLimitResponse(err: unknown): boolean {
  return statusOf(err) === 429 || retryAfterMsOf(err) !== null;
}

/** Remaining Retry-After window of a host from earlier runs (ms, 0 = free). */
export function hostRateLimitRemainingMs(url: string, now = Date.now()): number {
  const host = hostOf(url);
  const until = host ? rateLimitedUntil.get(host) : undefined;
  if (until === undefined) return 0;
  if (until <= now) {
    rateLimitedUntil.delete(host!);
    return 0;
  }
  return until - now;
}

/** Test helper. */
export function resetDiscoveryHostBlocks() {
  rateLimitedUntil.clear();
}

export class DiscoveryBudget {
  readonly signal: AbortSignal;
  private readonly controller = new AbortController();
  private readonly deadlineAt: number;
  private readonly timer: ReturnType<typeof setTimeout>;
  private used = 0;
  private stop: DiscoveryStopReason | null = null;
  private readonly blockedHosts = new Set<string>();

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

  /** Records a failed request: a rate-limit response blocks its host (both transports). */
  noteFailure(url: string, err: unknown): void {
    if (!isRateLimitResponse(err)) return;
    const host = hostOf(url);
    if (!host) return;
    this.blockedHosts.add(host);
    const windowMs = Math.min(MAX_BLOCK_MS, retryAfterMsOf(err) ?? DEFAULT_RATE_LIMIT_BLOCK_MS);
    if (rateLimitedUntil.size >= MAX_TRACKED_HOSTS) {
      const oldest = rateLimitedUntil.keys().next().value;
      if (oldest !== undefined) rateLimitedUntil.delete(oldest);
    }
    rateLimitedUntil.delete(host);
    rateLimitedUntil.set(host, Date.now() + windowMs);
  }

  /** Redirect hops count against the budget and may not land on a blocked host. */
  readonly redirectGuard = (nextUrl: string): string | null => (this.take(nextUrl) ? nextUrl : null);

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
