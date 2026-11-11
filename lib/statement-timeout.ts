import { db, getDatabaseProvider } from "@/lib/db";

/**
 * N13: Postgres-side cap for expensive search reads (ad-hoc `q` and saved
 * searches: ILIKE / advanced search over text columns). A runaway query is
 * cancelled by the server (SQLSTATE 57014) instead of holding a connection.
 */
export const SEARCH_STATEMENT_TIMEOUT_MS = 8_000;

/** The part of the client a search read needs; satisfied by `db` and by a transaction client. */
export type ArticleReader = Pick<typeof db, "article">;

/**
 * Runs `fn` with a statement timeout. Postgres: inside one transaction with
 * `SET LOCAL statement_timeout` (scoped to that transaction, so the pooled
 * connection keeps its default afterwards). SQLite has no statement timeout;
 * `fn` runs on `db` unchanged.
 */
export async function withStatementTimeout<T>(fn: (client: ArticleReader) => Promise<T>, ms = SEARCH_STATEMENT_TIMEOUT_MS): Promise<T> {
  if (getDatabaseProvider() !== "postgresql") return fn(db);
  const timeout = Math.max(1, Math.trunc(ms));
  return db.$transaction(
    async (tx) => {
      // Integer literal only (never user input); SET does not take bind parameters.
      await tx.$executeRawUnsafe(`SET LOCAL statement_timeout = ${timeout}`);
      return fn(tx);
    },
    { timeout: timeout + 2_000, maxWait: 5_000 },
  );
}

/** True for Postgres "canceling statement due to statement timeout" (57014), however the adapter wraps it. */
export function isStatementTimeout(error: unknown): boolean {
  const text = error instanceof Error ? `${error.message} ${String((error as { code?: unknown }).code ?? "")}` : String(error);
  return /57014|statement timeout/i.test(text);
}
