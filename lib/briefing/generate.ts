// K2 orchestration (.pm/spec-ai-briefing.md §K2.6): cache, soft cache,
// rate limit, daily cap, in-flight dedupe, streaming + validation,
// persistence, fallback. GET never calls a provider; POST streams events.
import { db } from "@/lib/db";
import { logger } from "@/lib/logger";
import { decryptIfValue } from "@/lib/crypto";
import { checkRateLimit } from "@/lib/rate-limit";
import { isSelectableAiProvider, type AiConfig, type AiProvider } from "@/lib/ai-summary";
import { CitedOutputParser, outputStatus, type ParsedItem } from "@/lib/ai/citations";
import { AiBudgetError, classifyAiError } from "@/lib/ai/errors";
import { streamAiPrompt } from "@/lib/ai/stream";
import { checkBudget, isLocalProvider, reserveBudget, settleUsage, type Reservation } from "@/lib/ai/usage";
import { buildHeadlineDigest, citationOf } from "./fallback";
import { buildBriefingPrompt, MAX_OUT } from "./prompt";
import { MIN_UNITS, PROMPT_VERSION, inputArticleIds, inputHash, resolveBriefingScope, selectBriefingInput, type BriefingInput, type StoryUnit } from "./select";
import {
  briefingScopeKey,
  type AiState,
  type BriefingContent,
  type BriefingEvent,
  type BriefingItem,
  type BriefingResponse,
  type BriefingScope,
  type FallbackReason,
} from "./types";

const SOFT_HIT_MS = 30 * 60_000;
const SOFT_HIT_MAX_NEW = 3;
/** Briefings older than the longest window (72 h) are never shown or replayed. */
export const MAX_BRIEFING_AGE_MS = 72 * 3_600_000;

export const DEFAULT_MODELS: Record<AiProvider, string> = {
  openai: "gpt-4o-mini",
  anthropic: "claude-haiku-4-5-20251001",
  ollama: "llama3",
  gemini: "gemini-1.5-flash",
  openrouter: "openai/gpt-4o-mini",
  fake: "fake",
};

export class BriefingNotFoundError extends Error {
  constructor() {
    super("Not found");
    this.name = "BriefingNotFoundError";
  }
}

interface AiContext {
  config: AiConfig | null;
  model: string | null;
  /** Generate on open without a tap (local provider + user setting). */
  auto: boolean;
  capOff: boolean;
}

async function loadAiContext(userId: string): Promise<AiContext> {
  const user = await db.user.findUnique({
    where: { id: userId },
    select: { aiProvider: true, aiApiKey: true, aiModel: true, aiOllamaBaseUrl: true, briefingAuto: true, aiDailyTokenCap: true },
  });
  const provider = user?.aiProvider;
  const capOff = user?.aiDailyTokenCap === 0;
  if (!user || !provider || !isSelectableAiProvider(provider)) return { config: null, model: null, auto: false, capOff };
  const apiKey = decryptIfValue(user.aiApiKey);
  if (provider !== "ollama" && provider !== "fake" && !apiKey) return { config: null, model: null, auto: false, capOff };
  const model = user.aiModel?.trim() || DEFAULT_MODELS[provider];
  return {
    config: { provider, apiKey, model, ollamaBaseUrl: user.aiOllamaBaseUrl },
    model,
    // PM default: auto-generate only for local (free) providers; cloud → explicit "Briefing erstellen".
    auto: user.briefingAuto && isLocalProvider(provider),
    capOff,
  };
}

type StoredContent = BriefingContent & { inputIds?: string[] };

function publicContent(raw: string): BriefingContent | null {
  try {
    const { inputIds: _inputIds, ...content } = JSON.parse(raw) as StoredContent;
    return content;
  } catch {
    return null;
  }
}

function newStoriesSince(raw: string, input: BriefingInput): number {
  let ids: Set<string>;
  try {
    ids = new Set((JSON.parse(raw) as StoredContent).inputIds ?? []);
  } catch {
    return input.top.length + input.brief.length;
  }
  return [...input.top, ...input.brief].filter((u) => !u.memberIds.some((id) => ids.has(id))).length;
}

function windowOf(input: BriefingInput) {
  return { start: input.windowStart.toISOString(), end: input.windowEnd.toISOString() };
}

interface Prepared {
  scopeKey: string;
  input: BriefingInput;
  ai: AiContext;
}

async function prepare(userId: string, scope: BriefingScope, now: Date): Promise<Prepared> {
  const listScope = await resolveBriefingScope(userId, scope);
  if (!listScope) throw new BriefingNotFoundError();
  const [input, ai] = await Promise.all([selectBriefingInput(userId, scope, listScope, { now }), loadAiContext(userId)]);
  return { scopeKey: briefingScopeKey(scope), input, ai };
}

async function latestBriefing(userId: string, scopeKey: string, model: string, now: Date) {
  return db.briefing.findFirst({
    where: { userId, scopeKey, model, promptVersion: PROMPT_VERSION, createdAt: { gte: new Date(now.getTime() - MAX_BRIEFING_AGE_MS) } },
    orderBy: { createdAt: "desc" },
  });
}

/** Exact cache hit (same input, model, prompt version), unless older than 72 h. */
async function exactBriefing(userId: string, scopeKey: string, hash: string, model: string, now: Date) {
  const row = await db.briefing.findUnique({
    where: { userId_scopeKey_inputHash_model_promptVersion: { userId, scopeKey, inputHash: hash, model, promptVersion: PROMPT_VERSION } },
  });
  return row && now.getTime() - row.createdAt.getTime() <= MAX_BRIEFING_AGE_MS ? row : null;
}

// ─── GET ─────────────────────────────────────────────────────────────────────

/** Cached briefing (with staleness) or the headline digest. Never calls a provider. */
export async function getBriefingState(userId: string, scope: BriefingScope, o: { now?: Date } = {}): Promise<BriefingResponse> {
  const now = o.now ?? new Date();
  const { scopeKey, input, ai } = await prepare(userId, scope, now);
  const base: BriefingResponse = {
    briefing: null,
    briefingId: null,
    stale: null,
    ai: "off",
    generatedAt: null,
    seen: false,
    fallbackReason: null,
    totalUnread: input.totalUnread,
    auto: false,
    model: ai.model,
    lang: input.lang,
  };
  if (input.totalUnread === 0) return base;

  let aiState: AiState = "off";
  if (ai.config && !ai.capOff) {
    const est = buildBriefingPrompt(input, ai.config.provider).estIn + MAX_OUT;
    const budget = await checkBudget(userId, ai.config.provider, est, now);
    aiState = budget.ok ? "ready" : budget.reason === "off" ? "off" : "budget";
  }
  const tooFew = input.totalStories < MIN_UNITS;

  if (ai.config && ai.model && !tooFew) {
    const latest = await latestBriefing(userId, scopeKey, ai.model, now);
    const content = latest ? publicContent(latest.content) : null;
    if (latest && content) {
      const fresh = latest.inputHash === inputHash(input);
      const newStories = fresh ? 0 : newStoriesSince(latest.content, input);
      return {
        ...base,
        briefing: content,
        briefingId: latest.id,
        // Stale only when there is something new (a re-ranked / shrunk input alone is not "stale").
        stale: newStories > 0 ? { newStories } : null,
        ai: aiState,
        generatedAt: latest.createdAt.toISOString(),
        seen: !!latest.seenAt,
        auto: ai.auto && aiState === "ready",
      };
    }
  }
  const reason: FallbackReason | null = tooFew ? "too_few" : aiState === "off" ? "no_ai" : aiState === "budget" ? "budget" : null;
  return {
    ...base,
    briefing: buildHeadlineDigest(input),
    ai: aiState,
    fallbackReason: reason,
    auto: ai.auto && aiState === "ready" && !tooFew,
  };
}

// ─── POST (streamed generation) ─────────────────────────────────────────────

/** Event fan-out of one generation: late subscribers get the buffer replayed, then live events. */
class Broadcast {
  readonly events: BriefingEvent[] = [];
  private waiters = new Set<() => void>();
  closed = false;
  subscribers = 0;
  onIdle: (() => void) | null = null;

  push(event: BriefingEvent) {
    this.events.push(event);
    this.wake();
  }
  close() {
    this.closed = true;
    this.wake();
  }
  private wake() {
    const waiters = [...this.waiters];
    this.waiters.clear();
    waiters.forEach((w) => w());
  }
  async *subscribe(signal?: AbortSignal): AsyncGenerator<BriefingEvent> {
    this.subscribers++;
    let i = 0;
    const onAbort = () => this.wake();
    signal?.addEventListener("abort", onAbort, { once: true });
    try {
      for (;;) {
        while (i < this.events.length) yield this.events[i++];
        if (this.closed || signal?.aborted) return;
        await new Promise<void>((resolve) => this.waiters.add(resolve));
      }
    } finally {
      signal?.removeEventListener("abort", onAbort);
      this.subscribers--;
      if (this.subscribers === 0) this.onIdle?.();
    }
  }
}

const IN_FLIGHT_KEY = "__feedferret_briefing_inflight__";
function inFlight(): Map<string, Broadcast> {
  const g = globalThis as unknown as Record<string, Map<string, Broadcast>>;
  return (g[IN_FLIGHT_KEY] ??= new Map());
}

/** Number of provider generations currently running (tests). */
export function inFlightCount(): number {
  return inFlight().size;
}

function timeouts(provider: string) {
  const local = isLocalProvider(provider);
  let first = local ? 60_000 : 20_000;
  let total = local ? 120_000 : 45_000;
  const override = Number(process.env.FEEDFERRET_AI_TIMEOUT_MS);
  if (Number.isFinite(override) && override > 0) {
    first = Math.min(first, override);
    total = Math.min(total, override);
  }
  return { first, total };
}

function toItem(parsed: ParsedItem<StoryUnit>): BriefingItem {
  return { text: parsed.text, citations: parsed.cited.map((u) => citationOf(u)) };
}

function* replayStored(row: { id: string; content: string; status: string; createdAt: Date; storyCount: number }, stale: { newStories: number } | null): Generator<BriefingEvent> {
  const content = publicContent(row.content);
  if (!content) return;
  yield { type: "meta", briefingId: row.id, storyCount: row.storyCount, cached: true, stale, window: content.window };
  for (const section of ["what", "why", "brief"] as const) for (const item of content[section]) yield { type: "item", section, item };
  if (content.dropped) yield { type: "dropped", count: content.dropped };
  yield { type: "done", status: row.status === "partial" ? "partial" : "ok", usage: { in: 0, out: 0 }, briefingId: row.id, generatedAt: row.createdAt.toISOString() };
}

function* fallbackEvents(input: BriefingInput, reason: FallbackReason): Generator<BriefingEvent> {
  yield { type: "meta", briefingId: null, storyCount: input.totalStories, cached: false, window: windowOf(input) };
  yield { type: "fallback", reason, briefing: buildHeadlineDigest(input) };
}

export interface GenerateOptions {
  force?: boolean;
  /** Client disconnect: the generation continues in the background once ≥1 item validated. */
  signal?: AbortSignal;
  now?: Date;
}

/**
 * Prepares a POST: resolves + ownership-checks the scope BEFORE the response
 * starts (so a foreign scope is a plain 404), then returns the event stream.
 */
export async function startBriefing(userId: string, scope: BriefingScope, o: GenerateOptions = {}): Promise<AsyncGenerator<BriefingEvent>> {
  const now = o.now ?? new Date();
  const prepared = await prepare(userId, scope, now);
  return briefingEvents(userId, prepared, o, now);
}

async function* briefingEvents(userId: string, { scopeKey, input, ai }: Prepared, o: GenerateOptions, now: Date): AsyncGenerator<BriefingEvent> {
  if (!ai.config || !ai.model || ai.capOff) return yield* fallbackEvents(input, "no_ai");
  if (input.totalStories < MIN_UNITS) return yield* fallbackEvents(input, "too_few");
  const config = ai.config;
  const model = ai.model;
  const hash = inputHash(input);

  // 1. Exact cache hit → replay (no provider call, no rate limit).
  const exact = await exactBriefing(userId, scopeKey, hash, model, now);
  if (exact) return yield* replayStored(exact, null);

  // 2. Soft hit: a recent briefing that misses fewer than 3 new stories.
  const latest = await latestBriefing(userId, scopeKey, model, now);
  if (latest && !o.force && now.getTime() - latest.createdAt.getTime() < SOFT_HIT_MS) {
    const newStories = newStoriesSince(latest.content, input);
    if (newStories < SOFT_HIT_MAX_NEW) return yield* replayStored(latest, newStories > 0 ? { newStories } : null);
  }

  // 3. Daily cap pre-check (read-only; cloud providers; cap 0 = off was handled
  //    above). The authoritative atomic reservation happens in runGeneration.
  const built = buildBriefingPrompt(input, config.provider);
  const budget = await checkBudget(userId, config.provider, built.estIn + MAX_OUT, now);
  if (!budget.ok) return yield* fallbackEvents(input, budget.reason === "off" ? "no_ai" : "budget");

  // 3b. A concurrent request may have finished the same input meanwhile.
  const exactAgain = await exactBriefing(userId, scopeKey, hash, model, now);
  if (exactAgain) return yield* replayStored(exactAgain, null);

  // From here on no `await` until the generation is registered: concurrent
  // requests for the same input must find it in the in-flight map.
  // 4. Same input already generating → join it (one provider call).
  const key = `${userId}:${scopeKey}:${hash}:${model}`;
  const running = inFlight().get(key);
  if (running) return yield* running.subscribe(o.signal);

  // 5. Rate limits (misses only), per user.
  const limited =
    !checkRateLimit(userId, { prefix: "briefing", limit: 10, windowSecs: 3600 }).success ||
    (o.force && !checkRateLimit(userId, { prefix: "briefing-force", limit: 3, windowSecs: 600 }).success);
  if (limited) {
    yield { type: "error", code: "rate_limited" };
    if (latest) {
      const newStories = newStoriesSince(latest.content, input);
      return yield* replayStored(latest, newStories > 0 ? { newStories } : null);
    }
    return yield* fallbackEvents(input, "rate_limited");
  }

  // 6. Generate.
  const broadcast = new Broadcast();
  inFlight().set(key, broadcast);
  const controller = new AbortController();
  let validated = 0;
  broadcast.onIdle = () => {
    if (validated === 0 && !broadcast.closed) controller.abort(new DOMException("Client gone", "AbortError"));
  };
  void runGeneration({ userId, scopeKey, input, config, model, hash, built, broadcast, controller, now, onItem: () => validated++ }).finally(() => {
    inFlight().delete(key);
    broadcast.close();
  });
  yield* broadcast.subscribe(o.signal);
}

interface RunArgs {
  userId: string;
  scopeKey: string;
  input: BriefingInput;
  config: AiConfig;
  model: string;
  hash: string;
  built: ReturnType<typeof buildBriefingPrompt>;
  broadcast: Broadcast;
  controller: AbortController;
  now: Date;
  onItem: () => void;
}

async function runGeneration(a: RunArgs): Promise<void> {
  const { input, broadcast, controller } = a;
  // Atomic reservation (input estimate + max output) before the provider call:
  // two generations near the cap can never both pass.
  let reservation: Reservation;
  try {
    reservation = await reserveBudget(a.userId, a.config.provider, a.built.estIn + MAX_OUT, a.now);
  } catch (error) {
    const reason: FallbackReason = error instanceof AiBudgetError ? (error.cap === 0 ? "no_ai" : "budget") : "provider_error";
    for (const event of fallbackEvents(input, reason)) broadcast.push(event);
    return;
  }
  if (controller.signal.aborted) return void (await settleUsage(reservation, "briefing", 0, 0)); // gone before the call
  const limits = timeouts(a.config.provider);
  let timedOut = false;
  const timeoutAbort = () => {
    timedOut = true;
    controller.abort(new DOMException("Timed out", "TimeoutError"));
  };
  let firstTimer: ReturnType<typeof setTimeout> | null = setTimeout(timeoutAbort, limits.first);
  const totalTimer = setTimeout(timeoutAbort, limits.total);
  const parser = new CitedOutputParser(a.built.aliases, { groundingText: (u) => `${u.title} ${u.excerpt}` });
  const content: BriefingContent = { mode: "ai", what: [], why: [], brief: [], dropped: 0, storyCount: input.totalStories, window: windowOf(input) };
  let outChars = 0;
  let usage: { in: number; out: number } | null = null;
  const emit = (items: ParsedItem<StoryUnit>[]) => {
    for (const parsed of items) {
      const item = toItem(parsed);
      content[parsed.section].push(item);
      a.onItem();
      broadcast.push({ type: "item", section: parsed.section, item });
    }
  };

  broadcast.push({ type: "meta", briefingId: null, storyCount: input.totalStories, cached: false, stale: null, window: content.window });
  try {
    for await (const part of streamAiPrompt(a.built.prompt, a.config, { maxTokens: MAX_OUT, signal: controller.signal })) {
      if ("usage" in part) {
        usage = part.usage;
        continue;
      }
      if (firstTimer) {
        clearTimeout(firstTimer);
        firstTimer = null;
      }
      outChars += part.text.length;
      emit(parser.push(part.text));
    }
    emit(parser.end());
  } catch (error) {
    clearTimeout(totalTimer);
    if (firstTimer) clearTimeout(firstTimer);
    const code = timedOut ? "timeout" : classifyAiError(error);
    const outTokens = Math.ceil(outChars / 3.5);
    // Client gone before anything validated: nothing to keep, but the provider
    // already processed (and billed) the input.
    if (controller.signal.aborted && !timedOut) return void (await settleUsage(reservation, "briefing", a.built.estIn, outTokens));
    logger.warn(`[briefing] generation failed (${code})`);
    // Timeout (incl. first-token timeout) or a stream that broke mid-way: input
    // counted; a request the provider rejected outright releases the reservation.
    await settleUsage(reservation, "briefing", code === "timeout" || outChars > 0 ? a.built.estIn : 0, outTokens);
    broadcast.push({ type: "error", code });
    broadcast.push({ type: "fallback", reason: "provider_error", briefing: buildHeadlineDigest(input) });
    return;
  }
  clearTimeout(totalTimer);
  if (firstTimer) clearTimeout(firstTimer);

  const tokensIn = usage?.in ?? a.built.estIn;
  const tokensOut = usage?.out ?? Math.ceil(outChars / 3.5);
  await settleUsage(reservation, "briefing", tokensIn, tokensOut);
  content.dropped = parser.dropped;
  if (parser.dropped) broadcast.push({ type: "dropped", count: parser.dropped });

  const status = outputStatus(parser.counts);
  if (status === "invalid_output") {
    broadcast.push({ type: "error", code: "invalid_output" });
    broadcast.push({ type: "fallback", reason: "invalid_output", briefing: buildHeadlineDigest(input) });
    return;
  }
  const stored: StoredContent = { ...content, inputIds: inputArticleIds(input) };
  let row: { id: string; createdAt: Date } | null = null;
  try {
    const data = {
      windowStart: input.windowStart,
      windowEnd: input.windowEnd,
      provider: a.config.provider,
      status,
      content: JSON.stringify(stored),
      storyCount: input.totalStories,
      tokensIn,
      tokensOut,
    };
    row = await db.briefing.upsert({
      where: { userId_scopeKey_inputHash_model_promptVersion: { userId: a.userId, scopeKey: a.scopeKey, inputHash: a.hash, model: a.model, promptVersion: PROMPT_VERSION } },
      create: { userId: a.userId, scopeKey: a.scopeKey, inputHash: a.hash, model: a.model, promptVersion: PROMPT_VERSION, ...data },
      update: { ...data, seenAt: null },
      select: { id: true, createdAt: true },
    });
  } catch (error) {
    logger.error("[briefing] could not persist briefing:", error instanceof Error ? error.message : error);
  }
  broadcast.push({ type: "done", status, usage: { in: tokensIn, out: tokensOut }, briefingId: row?.id ?? null, generatedAt: row?.createdAt.toISOString() ?? null });
}

// ─── Seen ───────────────────────────────────────────────────────────────────

/** Marks a briefing seen (idempotent). `false` = not this user's briefing. */
export async function markBriefingSeen(userId: string, briefingId: string, now: Date = new Date()): Promise<boolean> {
  const row = await db.briefing.findFirst({ where: { id: briefingId, userId }, select: { id: true, seenAt: true } });
  if (!row) return false;
  if (!row.seenAt) await db.briefing.updateMany({ where: { id: briefingId, userId, seenAt: null }, data: { seenAt: now } });
  return true;
}

/** Retention: briefings older than 14 days, usage rows older than 90 days. */
export async function cleanupBriefingData(now: Date = new Date()): Promise<{ briefings: number; usage: number }> {
  const briefings = await db.briefing.deleteMany({ where: { createdAt: { lt: new Date(now.getTime() - 14 * 86_400_000) } } });
  const cutoffDay = new Date(now.getTime() - 90 * 86_400_000).toISOString().slice(0, 10);
  const usage = await db.aiUsage.deleteMany({ where: { day: { lt: cutoffDay } } });
  await db.aiBudgetDay.deleteMany({ where: { day: { lt: cutoffDay } } });
  return { briefings: briefings.count, usage: usage.count };
}
