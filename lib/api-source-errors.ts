/** Conditions of an API platform source that say nothing about an individual
 * feed (credentials missing/rejected, shared quota exhausted). Sync treats them
 * like a saturated HTML worker: no failure streak, no auto-mute, retry later. */
export type ApiSourceDeferredReason = "unconfigured" | "rate-limited" | "auth";

export class ApiSourceDeferredError extends Error {
  constructor(
    readonly reason: ApiSourceDeferredReason,
    message: string,
    /** HTTP status of the upstream answer, when there was one (never a body). */
    readonly status?: number,
  ) {
    super(message);
    this.name = "ApiSourceDeferredError";
  }
}

export function isApiSourceDeferredError(error: unknown): error is ApiSourceDeferredError {
  return error instanceof ApiSourceDeferredError || (error instanceof Error && error.name === "ApiSourceDeferredError");
}
