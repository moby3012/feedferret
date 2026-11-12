// Background re-seal of stored secrets at boot (security audit #2, M8 PR 5).
//
// Runs once per process after startup (never awaited): legacy plaintext / v1
// values and values sealed with a key from FEEDFERRET_ENCRYPTION_KEYS_OLD are
// re-sealed with the current key (see lib/secret-migration-core.mjs: CAS,
// batched, keeps updatedAt). A row the configured keys cannot open never
// stops startup: it is counted, logged with column + shortened id + reason,
// written to the SystemLog ("security") and shown in the admin status.
// Opt out with FEEDFERRET_SECRET_MIGRATION=0 (then run `secrets:migrate`).
import { db } from "@/lib/db";
import { migrateSecrets } from "@/lib/secret-migration-core.mjs";
import { getKeyring } from "@/lib/secret-box";
import { writeSystemLog } from "@/lib/system-log";

export type SecretMigrationReport = Awaited<ReturnType<typeof migrateSecrets>> & { finishedAt: string };

const state = globalThis as unknown as { __ffSecretMigration?: { running: boolean; last: SecretMigrationReport | null; error: string | null } };

function current() {
  return (state.__ffSecretMigration ??= { running: false, last: null, error: null });
}

export function secretMigrationEnabled(env: Record<string, string | undefined> = process.env): boolean {
  const value = env.FEEDFERRET_SECRET_MIGRATION?.trim().toLowerCase();
  return !(value === "0" || value === "false" || value === "off");
}

/** Last boot-time report (or null while running / disabled). */
export function getSecretMigrationState() {
  const { running, last, error } = current();
  return { running, last, error, enabled: secretMigrationEnabled() };
}

export async function runSecretMigration(client: unknown = db): Promise<SecretMigrationReport | null> {
  const s = current();
  if (s.running) return null;
  s.running = true;
  try {
    const report = { ...(await migrateSecrets(client, { keyring: getKeyring(), mode: "rotate" })), finishedAt: new Date().toISOString() };
    s.last = report;
    s.error = null;
    for (const problem of report.problems) {
      // Column + shortened row id + reason only; never the stored value.
      console.warn(`[secrets] ${problem.column} row ${problem.id}: cannot be decrypted (${problem.reason})`);
    }
    const { resealed, undecryptable, conflicts } = report.totals;
    if (resealed || undecryptable || report.oauthTokensCleared) {
      console.info("[secrets] re-seal pass", { resealed, undecryptable, conflicts, oauthTokensCleared: report.oauthTokensCleared, key: report.keys.current });
      await writeSystemLog(
        undecryptable ? "warn" : "info",
        "security",
        undecryptable
          ? `${undecryptable} stored secret(s) cannot be decrypted with the configured keys`
          : `Re-sealed ${resealed} stored secret(s) with the current key`,
        {
          key: report.keys.current,
          resealed,
          undecryptable,
          conflicts,
          oauthTokensCleared: report.oauthTokensCleared,
          problems: report.problems.slice(0, 20),
        },
      );
    }
    return report;
  } catch (error) {
    s.error = error instanceof Error ? error.message : String(error);
    console.error("[secrets] re-seal pass failed; stored secrets stay readable, run `secrets:migrate` manually", s.error);
    return null;
  } finally {
    s.running = false;
  }
}

export function startSecretMigration() {
  if (!secretMigrationEnabled()) return;
  void runSecretMigration();
}
