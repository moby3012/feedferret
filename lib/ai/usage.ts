// AI token accounting + the server-side daily cap (K2). Every AI call that
// passes `usage` in its AiConfig (briefing, tagging, summary, digest,
// extraction) reserves its estimated tokens before it runs and settles to the
// actual usage afterwards.
//
// Cap: `User.aiDailyTokenCap` (null = server default from env
// AI_DAILY_TOKEN_CAP, else 150 000; 0 = AI off). The day is the UTC day.
//
// - `AiBudgetDay` (one row per user/day) is the cap's source of truth: cloud
//   tokens used today INCLUDING in-flight reservations. A reservation is ONE
//   conditional increment (`tokens <= cap - estimate`), atomic on SQLite and
//   Postgres alike, so two concurrent calls near the cap can never both pass.
// - `AiUsage` (user/day/feature/kind) is statistics: what each feature used,
//   cloud vs local. Local Ollama is never capped (no cost) and never touches
//   `AiBudgetDay`; rate limits apply regardless.
import { db } from "@/lib/db";
import { logger } from "@/lib/logger";
import { AiBudgetError } from "./errors";

export const DEFAULT_DAILY_TOKEN_CAP = 150_000;
export const MAX_DAILY_TOKEN_CAP = 10_000_000;

export type AiFeature = "briefing" | "tagging" | "summary" | "digest" | "extraction";
export type UsageKind = "cloud" | "local";

export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 3.5);
}

/** The cap's day: UTC (resets at 00:00 UTC). */
export function utcDay(now: Date = new Date()): string {
  return now.toISOString().slice(0, 10);
}

/** Start of the next UTC day — when a reached cap lifts. */
export function nextUtcMidnight(now: Date = new Date()): Date {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1));
}

export function serverDefaultCap(): number {
  const raw = Number(process.env.AI_DAILY_TOKEN_CAP);
  return Number.isFinite(raw) && raw >= 0 ? Math.floor(raw) : DEFAULT_DAILY_TOKEN_CAP;
}

/** Providers that cost nothing per token (never capped). */
export function isLocalProvider(provider: string | null | undefined): boolean {
  return provider === "ollama";
}

export function usageKind(provider: string | null | undefined): UsageKind {
  return isLocalProvider(provider) ? "local" : "cloud";
}

async function userCap(userId: string): Promise<number> {
  const user = await db.user.findUnique({ where: { id: userId }, select: { aiDailyTokenCap: true } });
  return user?.aiDailyTokenCap ?? serverDefaultCap();
}

/** Cloud tokens counted against the cap today (actual usage + in-flight reservations). */
export async function tokensUsedToday(userId: string, now: Date = new Date()): Promise<number> {
  const row = await db.aiBudgetDay.findUnique({ where: { userId_day: { userId, day: utcDay(now) } }, select: { tokens: true } });
  return row?.tokens ?? 0;
}

export interface BudgetState {
  ok: boolean;
  /** "off" = cap 0; "budget" = today's usage + estimate exceed the cap. */
  reason: "off" | "budget" | null;
  used: number;
  cap: number;
}

/**
 * Read-only pre-check (GET state, cheap early exits): whether a call
 * estimated at `estimate` tokens would fit right now. It reserves nothing —
 * only `reserveBudget` is authoritative. A DB error fails open with a warning.
 */
export async function checkBudget(userId: string, provider: string | null | undefined, estimate: number, now: Date = new Date()): Promise<BudgetState> {
  let cap = serverDefaultCap();
  let used = 0;
  try {
    cap = await userCap(userId);
    if (cap === 0) return { ok: false, reason: "off", used: 0, cap };
    if (isLocalProvider(provider)) return { ok: true, reason: null, used: 0, cap };
    used = await tokensUsedToday(userId, now);
  } catch (error) {
    logger.warn("[ai-usage] budget check failed, allowing the call:", error instanceof Error ? error.message : error);
    return { ok: true, reason: null, used, cap };
  }
  return used + estimate > cap ? { ok: false, reason: "budget", used, cap } : { ok: true, reason: null, used, cap };
}

/** A granted budget reservation; settle it exactly once with `settleUsage`. */
export interface Reservation {
  userId: string;
  kind: UsageKind;
  day: string;
  /** Tokens held on `AiBudgetDay` (0 for local providers / fail-open). */
  reserved: number;
}

/** Creates today's counter row if missing (a concurrent create is fine). `true` = it was missing. */
async function ensureBudgetRow(userId: string, day: string): Promise<boolean> {
  const exists = await db.aiBudgetDay.findUnique({ where: { userId_day: { userId, day } }, select: { userId: true } });
  if (exists) return false;
  try {
    await db.aiBudgetDay.create({ data: { userId, day }, select: { userId: true } });
  } catch {
    /* created concurrently */
  }
  return true;
}

/**
 * Atomically reserves `estimate` cloud tokens for today, or throws
 * `AiBudgetError` (cap reached, or cap 0 = AI off — the latter also for local
 * providers). Local providers reserve nothing. A DB error fails open (warning)
 * so a transient error never breaks sync.
 */
export async function reserveBudget(userId: string, provider: string | null | undefined, estimate: number, now: Date = new Date()): Promise<Reservation> {
  const kind = usageKind(provider);
  const day = utcDay(now);
  const amount = Math.max(0, Math.ceil(estimate));
  let cap: number;
  try {
    cap = await userCap(userId);
  } catch (error) {
    logger.warn("[ai-usage] cap lookup failed, allowing the call:", error instanceof Error ? error.message : error);
    return { userId, kind, day, reserved: 0 };
  }
  if (cap === 0) throw new AiBudgetError(0, 0);
  if (kind === "local") return { userId, kind, day, reserved: 0 };
  // The one atomic step: increment only while the result stays within the cap.
  const tryReserve = async () => (await db.aiBudgetDay.updateMany({ where: { userId, day, tokens: { lte: cap - amount } }, data: { tokens: { increment: amount } } })).count;
  let granted: number;
  try {
    granted = await tryReserve();
    if (granted === 0 && (await ensureBudgetRow(userId, day))) granted = await tryReserve();
  } catch (error) {
    logger.warn("[ai-usage] budget reservation failed, allowing the call:", error instanceof Error ? error.message : error);
    return { userId, kind, day, reserved: 0 };
  }
  if (granted === 1) return { userId, kind, day, reserved: amount };
  const used = await tokensUsedToday(userId, now).catch(() => cap);
  await db.aiBudgetDay.updateMany({ where: { userId, day, exhaustedAt: null }, data: { exhaustedAt: now } }).catch(() => {});
  throw new AiBudgetError(used, cap);
}

/**
 * Settles a reservation: records the actual tokens in `AiUsage` (per feature,
 * cloud/local) and moves `AiBudgetDay` from the estimate to the actual cloud
 * usage. `tokensIn + tokensOut = 0` (call never reached the provider) only
 * releases the reservation. Never throws.
 */
export async function settleUsage(r: Reservation, feature: AiFeature, tokensIn: number, tokensOut: number): Promise<void> {
  const tin = Math.max(0, Math.round(tokensIn));
  const tout = Math.max(0, Math.round(tokensOut));
  try {
    if (r.kind === "cloud") {
      const delta = tin + tout - r.reserved;
      if (delta !== 0) {
        if (r.reserved === 0) await ensureBudgetRow(r.userId, r.day);
        await db.aiBudgetDay.updateMany({ where: { userId: r.userId, day: r.day }, data: { tokens: { increment: delta } } });
      }
    }
    if (tin + tout === 0) return;
    await db.aiUsage.upsert({
      where: { userId_day_feature_kind: { userId: r.userId, day: r.day, feature, kind: r.kind } },
      create: { userId: r.userId, day: r.day, feature, kind: r.kind, tokensIn: tin, tokensOut: tout, calls: 1 },
      update: { tokensIn: { increment: tin }, tokensOut: { increment: tout }, calls: { increment: 1 } },
    });
  } catch (error) {
    logger.warn("[ai-usage] could not record usage:", error instanceof Error ? error.message : error);
  }
}

/** Records usage without a prior reservation (counts against the cap for cloud providers). Never throws. */
export async function recordUsage(userId: string, feature: AiFeature, tokensIn: number, tokensOut: number, provider: string | null = null, now: Date = new Date()): Promise<void> {
  await settleUsage({ userId, kind: usageKind(provider), day: utcDay(now), reserved: 0 }, feature, tokensIn, tokensOut);
}

// ─── Automatic features: stop at the cap, warn once per user and day ────────

const warned = new Map<string, string>();

/** Logs "cap reached, automatic AI paused" once per user and UTC day (not once per article). */
export function warnBudgetOnce(userId: string, source: string, error: AiBudgetError, now: Date = new Date()): void {
  const day = utcDay(now);
  if (warned.get(userId) === day) return;
  if (warned.size > 5_000) warned.clear();
  warned.set(userId, day);
  logger.warn(`[ai-usage] ${source}: ${error.message} — automatic AI features paused for user ${userId} until ${nextUtcMidnight(now).toISOString()}`);
}

// ─── Settings ───────────────────────────────────────────────────────────────

export interface UsageSummary {
  /** Cloud tokens counted against the cap today (incl. running calls). */
  usedToday: number;
  /** Local (Ollama) tokens today — shown, never capped. */
  localToday: number;
  cap: number;
  /** The configured value (null = server default). */
  userCap: number | null;
  defaultCap: number;
  /** A cloud call was refused today: automatic AI features are paused until `resetsAt`. */
  paused: boolean;
  /** Next reset of the daily counter (00:00 UTC), ISO. */
  resetsAt: string;
}

export async function usageSummary(userId: string, now: Date = new Date()): Promise<UsageSummary> {
  const day = utcDay(now);
  const [user, budget, local] = await Promise.all([
    db.user.findUnique({ where: { id: userId }, select: { aiDailyTokenCap: true } }),
    db.aiBudgetDay.findUnique({ where: { userId_day: { userId, day } }, select: { tokens: true, exhaustedAt: true } }),
    db.aiUsage.aggregate({ where: { userId, day, kind: "local" }, _sum: { tokensIn: true, tokensOut: true } }),
  ]);
  const defaultCap = serverDefaultCap();
  const userCap = user?.aiDailyTokenCap ?? null;
  const cap = userCap ?? defaultCap;
  return {
    usedToday: budget?.tokens ?? 0,
    localToday: (local._sum.tokensIn ?? 0) + (local._sum.tokensOut ?? 0),
    cap,
    userCap,
    defaultCap,
    paused: cap > 0 && !!budget?.exhaustedAt,
    resetsAt: nextUtcMidnight(now).toISOString(),
  };
}

/** A changed cap lifts today's "paused" state (the next refusal sets it again). */
export async function clearBudgetPause(userId: string, now: Date = new Date()): Promise<void> {
  await db.aiBudgetDay.updateMany({ where: { userId, day: utcDay(now) }, data: { exhaustedAt: null } }).catch(() => {});
}

/** Settings input → stored cap: null/"" = server default, else an integer 0…10M. */
export function normalizeCapInput(value: unknown): number | null {
  if (value === null || value === undefined || value === "") return null;
  const n = typeof value === "number" ? value : Number(String(value).trim());
  if (!Number.isFinite(n)) throw new Error("Invalid daily token cap");
  return Math.min(MAX_DAILY_TOKEN_CAP, Math.max(0, Math.floor(n)));
}
