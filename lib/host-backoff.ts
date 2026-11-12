// Per-host politeness for unattended page fetches (auto full text).
//
// A sync that hits a site which answers 429/403/5xx or times out must not keep
// hammering it article after article, sync after sync. This module keeps a small
// in-process failure record per host and tells callers to *defer* further
// fetches until the backoff window has passed. It is deliberately generic: no
// host lists, only HTTP semantics (429 + Retry-After, blocking statuses, server
// errors, network failures) and exponential growth per consecutive failure.
//
// State is in-memory on purpose: it only has to survive between the syncs of a
// running process, and a restart resetting it is harmless (the worst case is
// one extra probe per host).

import type { HttpStatusError } from "@/lib/ssrf";

/** `rateLimited`: the window comes from a 429 or a server-sent Retry-After (not just our own guess). */
type HostState = { failures: number; until: number; rateLimited: boolean };

const MAX_HOSTS = 5_000;
const MAX_BACKOFF_MS = 6 * 60 * 60 * 1000; // 6 h, local exponential delay only
const MAX_RETRY_AFTER_MS = 7 * 24 * 60 * 60 * 1000; // sanity cap for a server's Retry-After
const BASE_RATE_LIMIT_MS = 5 * 60 * 1000; // 429 without Retry-After
const BASE_BLOCKED_MS = 2 * 60 * 1000; // 401/402/403/451, 5xx
const BASE_NETWORK_MS = 60 * 1000; // timeouts, resets, DNS hiccups

const hosts = new Map<string, HostState>();

function hostOf(url: string): string | null {
    try {
        return new URL(url).hostname.toLowerCase();
    } catch {
        return null;
    }
}

function prune(now: number) {
    if (hosts.size < MAX_HOSTS) return;
    for (const [host, state] of hosts) {
        if (state.until <= now) hosts.delete(host);
    }
    // Still full (a flood of distinct failing hosts): drop the oldest entries.
    while (hosts.size >= MAX_HOSTS) {
        const first = hosts.keys().next().value;
        if (first === undefined) break;
        hosts.delete(first);
    }
}

/** Remaining backoff for this URL's host in ms, or 0 when a fetch may proceed. */
export function hostBackoffRemainingMs(url: string, now = Date.now()): number {
    const host = hostOf(url);
    if (!host) return 0;
    const state = hosts.get(host);
    if (!state) return 0;
    return Math.max(0, state.until - now);
}

function isHttpStatusError(error: unknown): error is HttpStatusError {
    return (
        error instanceof Error &&
        (error as { httpStatusError?: unknown }).httpStatusError === true &&
        typeof (error as { status?: unknown }).status === "number"
    );
}

export type FetchFailureKind = "rate_limited" | "blocked" | "network" | "permanent";

/** Classifies a page-fetch error. "permanent" (404/410, SSRF refusals, …) never backs a host off. */
export function classifyFetchFailure(error: unknown): { kind: FetchFailureKind; status: number | null; retryAfterMs: number | null } {
    // Duck-typed (not instanceof) so a mocked/duplicated ssrf module still classifies.
    if (isHttpStatusError(error)) {
        const { status, retryAfterMs } = error;
        if (status === 429) return { kind: "rate_limited", status, retryAfterMs };
        if (status === 401 || status === 402 || status === 403 || status === 451 || status >= 500) {
            return { kind: "blocked", status, retryAfterMs };
        }
        return { kind: "permanent", status, retryAfterMs };
    }
    const message = error instanceof Error ? error.message : String(error ?? "");
    const legacyStatus = message.match(/Fetch failed: (\d{3})/);
    if (legacyStatus) {
        const status = Number(legacyStatus[1]);
        if (status === 429) return { kind: "rate_limited", status, retryAfterMs: null };
        if (status === 401 || status === 402 || status === 403 || status === 451 || status >= 500) {
            return { kind: "blocked", status, retryAfterMs: null };
        }
        return { kind: "permanent", status, retryAfterMs: null };
    }
    if (/private IP|localhost|only supports http|URL is invalid|too large|Too many redirects|Redirect refused/i.test(message)) {
        return { kind: "permanent", status: null, retryAfterMs: null };
    }
    return { kind: "network", status: null, retryAfterMs: null };
}

/** Records a failed fetch for this URL's host and returns the resulting backoff in ms (0 = none). */
export function recordHostFailure(url: string, error: unknown, now = Date.now()): number {
    const host = hostOf(url);
    if (!host) return 0;
    const { kind, retryAfterMs } = classifyFetchFailure(error);
    if (kind === "permanent") return 0;
    const prior = hosts.get(host);
    const failures = (prior?.failures ?? 0) + 1;
    const base = kind === "rate_limited" ? BASE_RATE_LIMIT_MS : kind === "blocked" ? BASE_BLOCKED_MS : BASE_NETWORK_MS;
    // Only our own exponential guess is capped at 6 h; a server's explicit
    // Retry-After is honoured as sent (sanity-capped at 7 days).
    const exponential = Math.min(MAX_BACKOFF_MS, base * 2 ** (failures - 1));
    const retryAfter = Math.min(MAX_RETRY_AFTER_MS, Math.max(0, retryAfterMs ?? 0));
    const wait = Math.max(exponential, retryAfter);
    prune(now);
    hosts.delete(host); // re-insert so Map order approximates recency for pruning
    hosts.set(host, { failures, until: now + wait, rateLimited: kind === "rate_limited" || retryAfterMs !== null });
    return wait;
}

/**
 * Remaining window in ms when the host asked us to slow down (429 or a
 * Retry-After), else 0. Interactive callers (feed discovery) honour only this:
 * a full-text 403/5xx/network backoff must not block a user's explicit request.
 */
export function hostRateLimitRemainingMs(url: string, now = Date.now()): number {
    const host = hostOf(url);
    const state = host ? hosts.get(host) : undefined;
    if (!state?.rateLimited) return 0;
    return Math.max(0, state.until - now);
}

/** A successful fetch clears the host's record. */
export function recordHostSuccess(url: string) {
    const host = hostOf(url);
    if (host) hosts.delete(host);
}

/** Test helper. */
export function resetHostBackoff() {
    hosts.clear();
}

/** Honour an API's explicit quota reset even on a successful final request. */
export function recordHostRateLimit(url: string, resetAt: number, now = Date.now()) {
    const host = hostOf(url);
    if (!host || !Number.isFinite(resetAt) || resetAt <= now) return;
    prune(now);
    hosts.set(host, { failures: 0, until: Math.max(hosts.get(host)?.until ?? 0, Math.min(resetAt, now + MAX_RETRY_AFTER_MS)), rateLimited: true });
}
