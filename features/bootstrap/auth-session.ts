export const SESSION_CHECK_TIMEOUT_MS = 3000;

/**
 * Does the server still see a signed-in user for this browser? (`/api/auth/session`, never cached.)
 * Used by the sign-out to detect a session that a late in-flight request brought back. Throws on
 * network errors and after {@link SESSION_CHECK_TIMEOUT_MS} — the caller decides what an unreachable server means.
 */
export async function serverSessionAlive(): Promise<boolean> {
  const res = await fetch("/api/auth/session", { cache: "no-store", credentials: "same-origin", signal: AbortSignal.timeout(SESSION_CHECK_TIMEOUT_MS) });
  if (!res.ok) return false;
  const session = (await res.json()) as { user?: unknown } | null;
  return !!session?.user;
}
