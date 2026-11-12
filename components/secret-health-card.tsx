"use client";

// Admin status of stored-secret encryption (security audit #2, M8 PR 5):
// key ids, the last re-seal pass and rows the configured keys cannot open.
// Never shows a key, a stored value or a full row id.
import { useEffect, useState } from "react";
import { useTranslations } from "next-intl";
import { Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { getSecretHealth, runSecretResealNow, type SecretHealth } from "@/app/actions/admin";

export function SecretHealthCard() {
  const t = useTranslations("serverManagement.secrets");
  const [health, setHealth] = useState<SecretHealth | null>(null);
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    let cancelled = false;
    getSecretHealth()
      .then((value) => { if (!cancelled) setHealth(value); })
      .catch(() => { if (!cancelled) setFailed(true); });
    return () => { cancelled = true; };
  }, []);

  const rerun = async () => {
    setBusy(true);
    try {
      setHealth(await runSecretResealNow());
      setFailed(false);
    } catch {
      setFailed(true);
    } finally {
      setBusy(false);
    }
  };

  const m = health?.migration;
  return (
    <section className="max-w-2xl grid gap-3 p-6 rounded-panel bg-card border border-border/60" data-testid="secret-health">
      <div className="grid gap-1">
        <h3 className="text-body font-semibold">{t("title")}</h3>
        <p className="text-footnote text-muted-foreground">{t("description")}</p>
      </div>
      {failed && <p className="text-footnote text-destructive">{t("loadFailed")}</p>}
      {!health && !failed && <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />}
      {health && m && (
        <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-body-sm">
          <dt className="text-muted-foreground">{t("currentKey")}</dt>
          <dd><code>{health.currentKid}</code> · {health.keySource}</dd>
          <dt className="text-muted-foreground">{t("oldKeys")}</dt>
          <dd>{health.oldKids.length ? health.oldKids.map((kid) => <code key={kid} className="mr-2">{kid}</code>) : t("none")}</dd>
          <dt className="text-muted-foreground">{t("lastPass")}</dt>
          <dd>
            {m.running ? t("running") : !m.enabled && !m.finishedAt ? t("disabled") : m.finishedAt
              ? t("lastPassResult", { resealed: m.resealed, undecryptable: m.undecryptable, conflicts: m.conflicts })
              : t("notYet")}
          </dd>
        </dl>
      )}
      {health?.keySource === "AUTH_SECRET" && (
        <p className="text-footnote text-muted-foreground" data-testid="secret-health-auth-secret">{t("authSecretHint")}</p>
      )}
      {m?.error && <p className="text-footnote text-destructive">{t("passFailed")}</p>}
      {m && m.undecryptable > 0 && (
        <div className="grid gap-1 text-footnote text-destructive" data-testid="secret-health-undecryptable">
          <p>{t("undecryptableHint", { count: m.undecryptable })}</p>
          <ul className="list-disc pl-5">
            {m.problems.map((p) => (
              <li key={`${p.column}:${p.id}`}><code>{p.column}</code> · {p.id} · {p.reason}</li>
            ))}
          </ul>
        </div>
      )}
      {m && !m.enabled && (
        <p className="text-footnote text-muted-foreground" data-testid="secret-health-disabled">{t("disabledHint")}</p>
      )}
      <div className="flex justify-end">
        <Button variant="outline" className="rounded-panel" onClick={rerun} disabled={busy || !health || !m?.enabled}>
          {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : t("rerun")}
        </Button>
      </div>
    </section>
  );
}
