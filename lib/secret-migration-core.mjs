// Re-seal stored secrets (security audit #2, M8 PR 5). Plain ESM, shared by
// the standalone CLI (`secrets:migrate`, `secrets:rotate`) and the background
// job started at boot (lib/secret-migration.ts).
//
// - "migrate": legacy plaintext / v1 values → v2 under the current key.
// - "rotate":  everything not sealed with the current key (legacy formats and
//              v2 under a key from FEEDFERRET_ENCRYPTION_KEYS_OLD) → current key.
//
// Every write is a compare-and-swap on the stored string AND the observed
// `updatedAt` (`updateMany` where both still hold what was read), so any
// concurrent write to the row wins and is retried next pass; the re-seal keeps
// `updatedAt` (it is not a content change). Batched
// by id, idempotent, never logs or returns a secret value: problems carry the
// column, a shortened row id and the reason.
import {
  SECRET_COLUMNS,
  SecretKeyError,
  openSecret,
  sealV2,
  sealWebhookJson,
} from "./secret-box-core.mjs";

export const DEFAULT_BATCH_SIZE = 500;
const MAX_PROBLEMS = 100;

/** First characters of a row id, enough to find the row, never the whole value of anything secret. */
export function redactId(id) {
  const value = String(id ?? "");
  return value.length <= 8 ? value : `${value.slice(0, 8)}…`;
}

/**
 * @param {any} prisma
 * @param {{ model: string, column: string }} column
 * @param {number} batchSize
 */
async function* rows(prisma, column, batchSize) {
  let cursor;
  for (;;) {
    const batch = await prisma[column.model].findMany({
      where: { [column.column]: { not: null } },
      select: { id: true, updatedAt: true, [column.column]: true },
      orderBy: { id: "asc" },
      take: batchSize,
      ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
    });
    yield batch;
    if (batch.length < batchSize) return;
    cursor = batch[batch.length - 1].id;
  }
}

/**
 * Next stored value for one scalar column, or null when it is already current
 * (or, in "migrate" mode, sealed with an old key). Throws SecretKeyError.
 *
 * @param {{ purpose: string, legacy: "plaintext" | "v1" }} column
 * @param {string} stored
 * @param {"migrate" | "rotate"} mode
 * @param {ReturnType<import("./secret-box-core.mjs").loadKeyring>} keyring
 * @returns {{ next: string | null, oldKey: boolean }}
 */
function planScalar(column, stored, mode, keyring) {
  const opened = openSecret(column.purpose, stored, { legacy: column.legacy, keyring });
  if (!opened.stale) return { next: null, oldKey: false };
  if (opened.format === "v2" && mode === "migrate") return { next: null, oldKey: true };
  return { next: sealV2(column.purpose, opened.value, keyring), oldKey: opened.format === "v2" };
}

/**
 * @param {any} prisma  a PrismaClient (plain or the app's extended client)
 * @param {{
 *   keyring: ReturnType<import("./secret-box-core.mjs").loadKeyring>,
 *   mode?: "migrate" | "rotate",
 *   dryRun?: boolean,
 *   batchSize?: number,
 *   columns?: ReadonlyArray<typeof SECRET_COLUMNS[number]>,
 *   clearOAuthTokens?: boolean,
 *   yieldEvery?: () => Promise<void>,
 * }} options
 */
export async function migrateSecrets(prisma, options) {
  const {
    keyring,
    mode = "migrate",
    dryRun = false,
    batchSize = DEFAULT_BATCH_SIZE,
    columns: registry = SECRET_COLUMNS,
    clearOAuthTokens = true,
    yieldEvery = () => new Promise((resolve) => setImmediate(resolve)),
  } = options;
  if (keyring.current.source === "build") throw new Error("Refusing to re-seal secrets during the production build.");

  /** @type {Array<{ column: string, reason: string, id: string }>} */
  const problems = [];
  const columns = [];
  for (const column of registry) {
    const stats = { column: `${column.model}.${column.column}`, scanned: 0, current: 0, resealed: 0, oldKey: 0, undecryptable: 0, conflicts: 0 };
    for await (const batch of rows(prisma, column, batchSize)) {
      for (const row of batch) {
        const stored = row[column.column];
        if (typeof stored !== "string" || stored === "") continue;
        stats.scanned += 1;
        let next = null;
        try {
          if (column.json === "webhooks") {
            const sealed = sealWebhookJson(stored, keyring, { reseal: mode === "rotate" ? "all" : "legacy" });
            next = sealed === stored ? null : sealed;
          } else {
            const plan = planScalar(column, stored, mode, keyring);
            next = plan.next;
            if (!next && plan.oldKey) {
              stats.oldKey += 1;
              continue;
            }
          }
        } catch (error) {
          stats.undecryptable += 1;
          if (problems.length < MAX_PROBLEMS) {
            problems.push({
              column: stats.column,
              id: redactId(row.id),
              reason: error instanceof SecretKeyError ? error.reason : "error",
            });
          }
          continue;
        }
        if (!next) {
          stats.current += 1;
          continue;
        }
        if (dryRun) {
          stats.resealed += 1;
          continue;
        }
        const result = await prisma[column.model].updateMany({
          // CAS on the secret AND the observed updatedAt: any concurrent edit of
          // the row (even of another column) wins, and its updatedAt is never
          // rewound. Conflicts are retried by the next pass.
          where: { id: row.id, [column.column]: stored, ...(row.updatedAt ? { updatedAt: row.updatedAt } : {}) },
          data: { [column.column]: next, ...(row.updatedAt ? { updatedAt: row.updatedAt } : {}) },
        });
        if (result.count === 1) stats.resealed += 1;
        else stats.conflicts += 1; // row changed concurrently: skipped, retried next pass
      }
      await yieldEvery();
    }
    columns.push(stats);
  }

  // OAuth Account tokens (written by @auth/prisma-adapter) are never used by
  // the app; lib/secret-sealing.ts drops them on write, this clears old rows.
  let oauthTokensCleared = 0;
  if (clearOAuthTokens && prisma.account) {
    const where = { OR: [{ access_token: { not: null } }, { refresh_token: { not: null } }, { id_token: { not: null } }] };
    oauthTokensCleared = dryRun
      ? await prisma.account.count({ where })
      : (await prisma.account.updateMany({ where, data: { access_token: null, refresh_token: null, id_token: null } })).count;
  }

  const totals = columns.reduce(
    (sum, c) => ({
      scanned: sum.scanned + c.scanned,
      current: sum.current + c.current,
      resealed: sum.resealed + c.resealed,
      oldKey: sum.oldKey + c.oldKey,
      undecryptable: sum.undecryptable + c.undecryptable,
      conflicts: sum.conflicts + c.conflicts,
    }),
    { scanned: 0, current: 0, resealed: 0, oldKey: 0, undecryptable: 0, conflicts: 0 },
  );
  return {
    mode,
    dryRun,
    keys: { current: keyring.current.kid, source: keyring.current.source, old: keyring.old.map((k) => k.kid) },
    columns,
    totals,
    problems,
    problemsTruncated: totals.undecryptable > problems.length,
    oauthTokensCleared,
  };
}

