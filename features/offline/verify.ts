// Asks the server who the session cookie belongs to (GET /api/app/session).

export type ServerSession =
  /** Same account as the stored data. */
  | "ok"
  /** No live session any more (401): the stored data must go. */
  | "unauthorized"
  /** A different account is signed in now. */
  | "mismatch"
  /** Network down, timeout, 5xx: says nothing about the session. */
  | "unreachable";

const TIMEOUT_MS = 6000;

export async function checkServerSession(userId: string, fetchImpl: typeof fetch = fetch): Promise<ServerSession> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const response = await fetchImpl("/api/app/session", { cache: "no-store", credentials: "same-origin", signal: controller.signal });
    if (response.status === 401) return "unauthorized";
    if (!response.ok) return "unreachable";
    const body = (await response.json()) as { userId?: string };
    return body.userId === userId ? "ok" : "mismatch";
  } catch {
    return "unreachable";
  } finally {
    clearTimeout(timer);
  }
}
