// Typed AI provider failures. Provider response bodies may echo prompts or
// keys, so only the code (never the raw body) ever reaches a client.

export type AiErrorCode = "provider_auth" | "provider_down" | "timeout";

export class AiProviderError extends Error {
  constructor(
    readonly code: AiErrorCode,
    readonly status: number | null,
    message: string,
  ) {
    super(message);
    this.name = "AiProviderError";
  }
}

/** Over the user's daily token cap (or AI switched off with cap 0). */
export class AiBudgetError extends Error {
  constructor(
    readonly used: number,
    readonly cap: number,
  ) {
    super(cap === 0 ? "AI is switched off for this account (daily token cap 0)" : `Daily AI token cap reached (${used}/${cap})`);
    this.name = "AiBudgetError";
  }
}

export function codeForStatus(status: number): AiErrorCode {
  return status === 401 || status === 403 ? "provider_auth" : "provider_down";
}

/**
 * Maps any thrown value of an AI call to an error code. Understands
 * `AiProviderError`, abort/timeout errors and the legacy
 * `"{Provider} {status}: …"` messages of lib/ai-summary.ts.
 */
export function classifyAiError(error: unknown): AiErrorCode {
  if (error instanceof AiProviderError) return error.code;
  const name = error instanceof Error ? error.name : "";
  const message = error instanceof Error ? error.message : String(error);
  if (name === "TimeoutError" || name === "AbortError" || /timed? ?out|aborted/i.test(message)) return "timeout";
  const status = /^\w+ (\d{3}):/.exec(message)?.[1];
  if (status) return codeForStatus(Number(status));
  return "provider_down";
}
