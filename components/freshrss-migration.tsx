"use client";

import { useRef, useState } from "react";
import { useTranslations } from "next-intl";
import { useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { AlertTriangle, CheckCircle2, FileArchive, Loader2, Upload } from "lucide-react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import type { FreshRssMigrationReport } from "@/lib/import/freshrss-migration";
import type { ImportIssue } from "@/lib/import/opml-import";

/** Mirrors FRESHRSS_UPLOAD_MAX_BYTES on the server (kept literal: that module is server-only). */
const MAX_UPLOAD_MB = 64;

type Phase =
  | { step: "idle" }
  | { step: "analyzing" }
  | { step: "preview"; report: FreshRssMigrationReport }
  | { step: "importing"; report: FreshRssMigrationReport }
  | { step: "done"; report: FreshRssMigrationReport }
  | { step: "error"; message: string };

async function upload(file: File, dryRun: boolean): Promise<FreshRssMigrationReport> {
  const response = await fetch(`/api/import/freshrss${dryRun ? "?dryRun=1" : ""}`, {
    method: "POST",
    body: file,
    headers: { "content-type": "application/octet-stream" },
  });
  const body = await response.json().catch(() => null);
  if (!response.ok) throw new Error(body?.error?.message ?? `HTTP ${response.status}`);
  return body as FreshRssMigrationReport;
}

function Stat({ label, value, tone = "muted" }: { label: string; value: number; tone?: "muted" | "success" | "warning" }) {
  return (
    <div
      className={cn(
        "flex items-center justify-between gap-3 rounded-row px-3 py-2 text-body-sm",
        tone === "success" && "bg-success/10 text-success",
        tone === "warning" && "bg-warning/10 text-warning",
        tone === "muted" && "bg-muted text-foreground",
      )}
    >
      <span>{label}</span>
      <span className="font-semibold tabular-nums">{value}</span>
    </div>
  );
}

function IssueList({ title, issues, tone }: { title: string; issues: ImportIssue[]; tone: "danger" | "warning" | "muted" }) {
  const t = useTranslations("feedManagement.freshrss");
  const [expanded, setExpanded] = useState(false);
  if (issues.length === 0) return null;
  const visible = expanded ? issues : issues.slice(0, 5);
  const label = (code: string) => (t.has(`issueCodes.${code}`) ? t(`issueCodes.${code}`) : code);
  return (
    <section className="space-y-2" aria-label={title}>
      <h4 className={cn("text-body-sm font-semibold", tone === "danger" && "text-destructive", tone === "warning" && "text-warning")}>
        {title} ({issues.length})
      </h4>
      <ul className="space-y-1.5">
        {visible.map((issue, index) => (
          <li key={`${issue.code}-${issue.subject}-${index}`} className="rounded-row bg-muted px-3 py-2 text-footnote">
            <span className="font-semibold">{issue.subject}</span>
            <span className="text-muted-foreground"> — {label(issue.code)}</span>
            {issue.attribute && <code className="ms-1 break-all text-muted-foreground">{issue.attribute}</code>}
            {issue.detail && <div className="mt-0.5 break-words text-muted-foreground">{issue.detail}</div>}
          </li>
        ))}
      </ul>
      {issues.length > 5 && (
        <button type="button" onClick={() => setExpanded((value) => !value)} className="text-footnote text-link underline-offset-4 hover:underline">
          {expanded ? t("showLess") : t("showAll", { count: issues.length })}
        </button>
      )}
    </section>
  );
}

function ReportView({ report, final }: { report: FreshRssMigrationReport; final: boolean }) {
  const t = useTranslations("feedManagement.freshrss");
  const opml = report.opml;
  const articles = report.articles?.counts;
  const unsupported = report.issues.filter((issue) => issue.kind === "unsupported");
  const adapted = report.issues.filter((issue) => issue.kind === "adapted");
  const preserved = report.issues.filter((issue) => issue.kind === "preserved");
  const errors = [...report.errors, ...(opml?.errors ?? []), ...(report.articles?.errors ?? [])];

  return (
    <div className="space-y-4">
      <div className="grid gap-2 sm:grid-cols-2">
        {opml && (
          <>
            <Stat label={t("stats.feedsNew")} value={opml.feedsAdded} tone="success" />
            <Stat label={t("stats.feedsExisting")} value={opml.feedsUpdated} />
            <Stat label={t("stats.categories")} value={opml.categoriesAdded} />
            <Stat label={t("stats.rules")} value={opml.rulesCreated + opml.rulesUpdated} />
          </>
        )}
        {articles && (
          <>
            <Stat label={t("stats.articlesNew")} value={articles.created} tone="success" />
            <Stat label={t("stats.articlesMerged")} value={articles.updated} />
            <Stat label={t("stats.articlesUnchanged")} value={articles.unchanged} />
            <Stat label={t("stats.starred")} value={articles.starred} />
            <Stat label={t("stats.read")} value={articles.read} />
            <Stat label={t("stats.labels")} value={articles.labelsCreated} />
            <Stat label={t("stats.orphanFeeds")} value={articles.orphanFeedsCreated} />
            {articles.skipped > 0 && <Stat label={t("stats.skipped")} value={articles.skipped} tone="warning" />}
          </>
        )}
      </div>

      {(articles?.orphanFeedsCreated ?? 0) > 0 && <p className="text-footnote text-muted-foreground">{t("orphanNote")}</p>}

      <section className="space-y-1.5" aria-label={t("files")}>
        <h4 className="text-body-sm font-semibold">{t("files")}</h4>
        <ul className="space-y-1">
          {report.files.map((file) => (
            <li key={file.name} className="flex items-start justify-between gap-3 text-footnote">
              <span className="break-all">{file.name}</span>
              <span className={cn("shrink-0", file.status === "error" ? "text-destructive" : "text-muted-foreground")}>
                {file.status === "ok" ? t("fileOk", { count: file.items ?? 0 }) : file.status === "skipped" ? t("fileSkipped") : t("fileError")}
              </span>
            </li>
          ))}
        </ul>
      </section>

      <IssueList title={t("issues.unsupported")} issues={unsupported} tone="danger" />
      <IssueList title={t("issues.adapted")} issues={adapted} tone="warning" />
      <IssueList title={t("issues.preserved")} issues={preserved} tone="muted" />

      {errors.length > 0 && (
        <section className="space-y-1.5" aria-label={t("errors")}>
          <h4 className="text-body-sm font-semibold text-destructive">
            {t("errors")} ({errors.length})
          </h4>
          <ul className="space-y-1">
            {errors.slice(0, 10).map((message, index) => (
              <li key={index} className="break-words text-footnote text-destructive">{message}</li>
            ))}
          </ul>
        </section>
      )}
      {final && report.files.some((file) => file.status === "error") && <p className="text-footnote text-muted-foreground">{t("rerunHint")}</p>}
    </div>
  );
}

export function FreshRssMigration() {
  const t = useTranslations("feedManagement.freshrss");
  const queryClient = useQueryClient();
  const inputRef = useRef<HTMLInputElement>(null);
  const [file, setFile] = useState<File | null>(null);
  const [phase, setPhase] = useState<Phase>({ step: "idle" });

  const reset = () => {
    setFile(null);
    setPhase({ step: "idle" });
    if (inputRef.current) inputRef.current.value = "";
  };

  const onPick = async (event: React.ChangeEvent<HTMLInputElement>) => {
    const picked = event.target.files?.[0];
    if (!picked) return;
    if (picked.size > MAX_UPLOAD_MB * 1024 * 1024) {
      setPhase({ step: "error", message: t("tooLarge", { size: MAX_UPLOAD_MB }) });
      return;
    }
    setFile(picked);
    setPhase({ step: "analyzing" });
    try {
      setPhase({ step: "preview", report: await upload(picked, true) });
    } catch (error) {
      setPhase({ step: "error", message: error instanceof Error ? error.message : String(error) });
    }
  };

  const confirm = async () => {
    if (!file || phase.step !== "preview") return;
    setPhase({ step: "importing", report: phase.report });
    try {
      const report = await upload(file, false);
      setPhase({ step: "done", report });
      await Promise.all(["feeds", "categories", "articles", "labels", "feed-health"].map((key) => queryClient.invalidateQueries({ queryKey: [key] })));
      toast.success(t("toastDone", { articles: report.articles?.counts.created ?? 0, feeds: report.opml?.feedsAdded ?? 0 }));
    } catch (error) {
      setPhase({ step: "error", message: error instanceof Error ? error.message : String(error) });
      toast.error(t("failed"));
    }
  };

  const busy = phase.step === "analyzing" || phase.step === "importing";

  return (
    <div className="space-y-4 rounded-panel border border-border/60 bg-card p-7" data-testid="freshrss-migration">
      <div className="flex items-center gap-3 text-title-sm font-semibold tracking-title text-primary">
        <FileArchive className="size-6" aria-hidden />
        <h3>{t("title")}</h3>
      </div>
      <p className="text-body-sm text-muted-foreground">{t("intro")}</p>

      {phase.step === "idle" && (
        <>
          <ol className="list-inside list-decimal space-y-1 text-body-sm text-muted-foreground">
            <li>{t("step1")}</li>
            <li>{t("step2")}</li>
            <li>{t("step3")}</li>
          </ol>
          <p className="text-footnote text-muted-foreground">{t("accepted", { size: MAX_UPLOAD_MB })}</p>
        </>
      )}

      <div aria-live="polite">
        {busy && (
          <div className="flex items-center gap-3 text-body-sm text-muted-foreground" role="status">
            <Loader2 className="size-5 animate-spin" aria-hidden />
            {phase.step === "analyzing" ? t("analyzing") : t("importing")}
          </div>
        )}

        {phase.step === "error" && (
          <div className="flex items-start gap-3 rounded-row bg-destructive/10 p-3 text-body-sm text-destructive" role="alert">
            <AlertTriangle className="mt-0.5 size-5 shrink-0" aria-hidden />
            <span className="break-words">{phase.message}</span>
          </div>
        )}
      </div>

      {(phase.step === "preview" || phase.step === "importing") && (
        <div className="space-y-3">
          <p className="flex items-center gap-2 text-body-sm font-semibold">
            <AlertTriangle className="size-4 text-warning" aria-hidden />
            {t("previewTitle")}
          </p>
          <ReportView report={phase.report} final={false} />
        </div>
      )}

      {phase.step === "done" && (
        <div className="space-y-3">
          <p className="flex items-center gap-2 text-body-sm font-semibold text-success">
            <CheckCircle2 className="size-4" aria-hidden />
            {t("resultTitle")}
          </p>
          <ReportView report={phase.report} final />
        </div>
      )}

      <div className="flex flex-wrap items-center gap-2">
        {(phase.step === "idle" || phase.step === "error") && (
          <>
            <Button type="button" onClick={() => inputRef.current?.click()} className="h-12 px-8">
              <Upload aria-hidden />
              {phase.step === "error" ? t("retry") : t("chooseFile")}
            </Button>
            <input
              ref={inputRef}
              type="file"
              accept=".zip,.opml,.xml,.json,application/zip,application/json,text/xml"
              className="sr-only"
              tabIndex={-1}
              aria-hidden
              data-testid="freshrss-file"
              onChange={onPick}
            />
          </>
        )}
        {phase.step === "preview" && (
          <>
            <Button type="button" onClick={confirm} data-testid="freshrss-confirm">
              {t("confirm")}
            </Button>
            <Button type="button" variant="ghost" onClick={reset}>
              {t("cancel")}
            </Button>
          </>
        )}
        {phase.step === "done" && (
          <Button type="button" variant="secondary" onClick={reset}>
            {t("done")}
          </Button>
        )}
      </div>
    </div>
  );
}
