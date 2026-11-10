// AI token accounting + the server-side daily cap (K2). Every AI call that
// passes `usage` in its AiConfig (briefing, tagging, summary, digest,
// extraction) is checked against the user's cap before it runs and recorded
// afterwards (`AiUsage`, one row per user/day/feature, upsert-increment).
//
// Cap: `User.aiDailyTokenCap` (null = server default from env
// AI_DAILY_TOKEN_CAP, else 150 000; 0 = AI off). Local Ollama is never capped
// (no cost) — its usage is still recorded; rate limits apply regardless.
import { db } from "@/lib/db";
import { logger } from "@/lib/logger";
import { AiBudgetError } from "./errors";

export const DEFAULT_DAILY_TOKEN_CAP = 150_000;
export const MAX_DAILY_TOKEN_CAP = 10_000_000;

export type AiFeature = "briefing" | "tagging" | "summary" | "digest" | "extraction";

export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 3.5);
}

export function utcDay(now: Date = new Date()): string {
  return now.toISOString().slice(0, 10);
}

export function serverDefaultCap(): number {
  const raw = Number(process.env.AI_DAILY_TOKEN_CAP);
  return Number.isFinite(raw) && raw >= 0 ? Math.floor(raw) : DEFAULT_DAILY_TOKEN_CAP;
}

/** Providers that cost nothing per token (never capped). */
export function isLocalProvider(provider: string | null | undefined): boolean {
  return provider === "ollama";
}

export async function tokensUsedToday(userId: string, now: Date = new Date()): Promise<number> {
  const rows = await db.aiUsage.findMany({ where: { userId, day: utcDay(now) }, select: { tokensIn: true, tokensOut: true } });
  return rows.reduce((sum, r) => sum + r.tokensIn + r.tokensOut, 0);
}

export interface BudgetState {
  ok: boolean;
  /** "off" = cap 0; "budget" = today's usage + estimate exceed the cap. */
  reason: "off" | "budget" | null;
  used: number;
  cap: number;
}

/**
 * Whether a call estimated at `estimate` tokens may run now. A failing usage
 * read never blocks AI for local providers; for cloud providers the cap is
 * enforced from the stored usage (a DB error there fails open with a warning,
 * so a transient read error never breaks sync).
 */
export async function checkBudget(userId: string, provider: string | null | undefined, estimate: number, now: Date = new Date()): Promise<BudgetState> {
  let cap = serverDefaultCap();
  let used = 0;
  try {
    const user = await db.user.findUnique({ where: { id: userId }, select: { aiDailyTokenCap: true } });
    if (user?.aiDailyTokenCap !== null && user?.aiDailyTokenCap !== undefined) cap = user.aiDailyTokenCap;
    if (cap === 0) return { ok: false, reason: "off", used: 0, cap };
    if (isLocalProvider(provider)) return { ok: true, reason: null, used: 0, cap };
    used = await tokensUsedToday(userId, now);
  } catch (error) {
    logger.warn("[ai-usage] budget check failed, allowing the call:", error instanceof Error ? error.message : error);
    return { ok: true, reason: null, used, cap };
  }
  return used + estimate > cap ? { ok: false, reason: "budget", used, cap } : { ok: true, reason: null, used, cap };
}

export async function assertBudget(userId: string, provider: string | null | undefined, estimate: number): Promise<void> {
  const state = await checkBudget(userId, provider, estimate);
  if (!state.ok) throw new AiBudgetError(state.used, state.cap);
}

/** Upsert-increments today's usage row. Never throws. */
export async function recordUsage(userId: string, feature: AiFeature, tokensIn: number, tokensOut: number, now: Date = new Date()): Promise<void> {
  const day = utcDay(now);
  const tin = Math.max(0, Math.round(tokensIn));
  const tout = Math.max(0, Math.round(tokensOut));
  try {
    await db.aiUsage.upsert({
      where: { userId_day_feature: { userId, day, feature } },
      create: { userId, day, feature, tokensIn: tin, tokensOut: tout, calls: 1 },
      update: { tokensIn: { increment: tin }, tokensOut: { increment: tout }, calls: { increment: 1 } },
    });
  } catch (error) {
    logger.warn("[ai-usage] could not record usage:", error instanceof Error ? error.message : error);
  }
}

export interface UsageSummary {
  usedToday: number;
  cap: number;
  /** The configured value (null = server default). */
  userCap: number | null;
  defaultCap: number;
}

export async function usageSummary(userId: string): Promise<UsageSummary> {
  const [user, usedToday] = await Promise.all([
    db.user.findUnique({ where: { id: userId }, select: { aiDailyTokenCap: true } }),
    tokensUsedToday(userId),
  ]);
  const defaultCap = serverDefaultCap();
  const userCap = user?.aiDailyTokenCap ?? null;
  return { usedToday, cap: userCap ?? defaultCap, userCap, defaultCap };
}

/** Settings input → stored cap: null/"" = server default, else an integer 0…10M. */
export function normalizeCapInput(value: unknown): number | null {
  if (value === null || value === undefined || value === "") return null;
  const n = typeof value === "number" ? value : Number(String(value).trim());
  if (!Number.isFinite(n)) throw new Error("Invalid daily token cap");
  return Math.min(MAX_DAILY_TOKEN_CAP, Math.max(0, Math.floor(n)));
}
