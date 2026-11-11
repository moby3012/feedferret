import { logger } from "./logger";

const directives = new Set(["script-src", "script-src-elem", "script-src-attr", "style-src", "style-src-elem", "style-src-attr", "img-src", "font-src", "connect-src", "worker-src", "manifest-src", "object-src", "frame-src", "frame-ancestors", "base-uri", "form-action", "default-src", "media-src"]);
const counts = new Map<string, number>();
let nextLog = 0;

/** Unauthenticated, attacker-controlled telemetry: retain only bounded directive
 * counters. Never retain/log URLs (even paths can contain share tokens), IPs,
 * cookies, samples, original policies/nonces, or arbitrary submitted strings. */
export function recordCspReports(payload: unknown): void {
  const reports = Array.isArray(payload) ? payload : [payload];
  for (const report of reports) {
    if (!report || typeof report !== "object") continue;
    const body = report["csp-report"] ?? (report.type === "csp-violation" ? report.body : null);
    if (!body || typeof body !== "object") continue;
    const raw = body["effective-directive"] ?? body.effectiveDirective;
    const directive = typeof raw === "string" && directives.has(raw) ? raw : "other";
    counts.set(directive, (counts.get(directive) ?? 0) + 1);
  }
  // Request-driven sampling: at most one aggregate per minute per process.
  // Later reports stay counted until the next request after the window.
  if (counts.size && Date.now() >= nextLog) {
    logger.warn("CSP report counts (untrusted telemetry)", Object.fromEntries(counts));
    counts.clear();
    nextLog = Date.now() + 60_000;
  }
}
