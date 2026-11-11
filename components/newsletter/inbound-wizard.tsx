"use client";

// N1 PR B: admin wizard "Newsletter-Eingang" (spec §10) — 3 steps:
// 1 choose the way in (IMAP recommended; Cloudflare/webhook coming later),
// 2 connect (address + app password, server auto-detected), 3 end-to-end test.
// Afterwards a status card (way, last mail, errors, pause / disconnect).

import { useCallback, useEffect, useRef, useState } from "react";
import { useFormatter, useTranslations } from "next-intl";
import { toast } from "sonner";
import { CheckCircle2, ChevronDown, Cloud, ExternalLink, Inbox, Loader2, Mail, Send, TriangleAlert, Webhook, Copy } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { cn } from "@/lib/utils";
import {
  checkNewsletterTestMail,
  detectNewsletterImapServer,
  disconnectNewsletterInbound,
  getNewsletterInboundState,
  saveNewsletterImap,
  startNewsletterTest,
  setNewsletterInboundPaused,
  testNewsletterImap,
  type InboundSourceView,
  type PresetView,
  type ServerView,
} from "@/app/actions/newsletter-admin";

const KEEP = "__keep__";
const POLL_EVERY_MS = 5_000;
const POLL_FOR_MS = 3 * 60_000;
/** A live test that hits one of these will not succeed by waiting longer. */
const FATAL_POLL_ERRORS = new Set(["auth-failed", "app-password-required", "imap-disabled", "credentials-unreadable", "host-blocked", "tls"]);
const ERROR_CODES = [
  "confirm-address-change", "invalid-email", "no-server", "password-required", "invalid-server", "auth-failed", "app-password-required", "imap-disabled",
  "tls", "timeout", "host-blocked", "host-not-found", "unreachable", "folder", "credentials-unreadable", "no-source", "send-failed", "unknown",
] as const;

type Step = "choose" | "connect" | "test";
type State = { source: InboundSourceView | null; mailAvailable: boolean; testAddress: string | null };

function useErrorText() {
  const t = useTranslations("newsletterInbound");
  return (code: string | null | undefined) => t(`errors.${(ERROR_CODES as readonly string[]).includes(code ?? "") ? code : "unknown"}`);
}

export function NewsletterInboundPanel() {
  const t = useTranslations("newsletterInbound");
  const [state, setState] = useState<State | null>(null);
  const [step, setStep] = useState<Step | null>(null);
  const [loadError, setLoadError] = useState(false);

  const reload = useCallback(async () => {
    try {
      const next = await getNewsletterInboundState();
      setState(next);
      setLoadError(false);
      return next;
    } catch {
      setLoadError(true);
      return null;
    }
  }, []);

  useEffect(() => {
    void reload();
  }, [reload]);

  if (loadError) return <p className="px-6 py-6 text-body-sm text-danger sm:px-8">{t("errors.unknown")}</p>;
  if (!state) {
    return (
      <div className="flex items-center justify-center py-16">
        <Loader2 className="size-6 animate-spin text-muted-foreground" aria-hidden />
      </div>
    );
  }

  const showWizard = !state.source || step !== null;
  const current: Step = step ?? "choose";

  return (
    <div className="max-w-2xl space-y-6 px-6 py-6 sm:px-8" data-testid="newsletter-inbound">
      <header className="space-y-1">
        <h2 className="text-title-sm font-semibold tracking-title">{t("title")}</h2>
        <p className="text-body-sm text-muted-foreground">{t("description")}</p>
      </header>

      {showWizard ? (
        <>
          <StepIndicator step={current} />
          {current === "choose" && <ChooseStep onNext={() => setStep("connect")} />}
          {current === "connect" && (
            <ConnectStep
              source={state.source}
              onBack={() => setStep(state.source ? null : "choose")}
              onSaved={async () => {
                await reload();
                setStep("test");
              }}
            />
          )}
          {current === "test" && (
            <TestStep
              mailAvailable={state.mailAvailable}
              onDone={async () => {
                await reload();
                setStep(null);
              }}
            />
          )}
        </>
      ) : (
        <StatusCard
          source={state.source!}
          onEdit={() => setStep("connect")}
          onTest={() => setStep("test")}
          onChanged={(source) => setState({ ...state, source })}
          onDisconnected={async () => {
            await reload();
            setStep("choose");
          }}
        />
      )}
    </div>
  );
}

function StepIndicator({ step }: { step: Step }) {
  const t = useTranslations("newsletterInbound");
  const steps: Step[] = ["choose", "connect", "test"];
  const index = steps.indexOf(step);
  return (
    <ol className="flex flex-wrap items-center gap-2" aria-label={t("stepLabel", { current: index + 1, total: steps.length })}>
      {steps.map((s, i) => (
        <li
          key={s}
          aria-current={i === index ? "step" : undefined}
          className={cn(
            "flex items-center gap-2 rounded-full border px-3 py-1 text-footnote",
            i === index ? "border-brand bg-brand/10 font-semibold text-foreground" : i < index ? "border-border text-muted-foreground" : "border-border/60 text-muted-foreground",
          )}
        >
          <span className="tabular-nums">{i + 1}</span>
          {t(`steps.${s}`)}
        </li>
      ))}
    </ol>
  );
}

function PathCard({ icon: Icon, title, body, badge, disabled, selected, onClick, testId }: {
  icon: typeof Inbox;
  title: string;
  body: string;
  badge: string;
  disabled?: boolean;
  selected?: boolean;
  onClick?: () => void;
  testId: string;
}) {
  return (
    <button
      type="button"
      disabled={disabled}
      aria-pressed={selected}
      onClick={onClick}
      data-testid={testId}
      className={cn(
        "flex w-full items-start gap-4 rounded-panel border p-4 text-start transition-colors duration-(--dur-fast) focus-ring",
        selected ? "border-brand bg-brand/5" : "border-border/60 bg-card",
        disabled ? "cursor-not-allowed opacity-60" : "hover:bg-surface-sunken",
      )}
    >
      <span className="ui-brand-icon flex size-10 shrink-0 items-center justify-center rounded-control">
        <Icon className="size-5" aria-hidden />
      </span>
      <span className="min-w-0 flex-1 space-y-1">
        <span className="flex flex-wrap items-center gap-2">
          <span className="text-body font-semibold">{title}</span>
          <span className={cn("rounded-full px-2 py-0.5 text-caption font-medium", disabled ? "bg-muted text-muted-foreground" : "bg-success/10 text-success")}>{badge}</span>
        </span>
        <span className="block text-body-sm text-muted-foreground">{body}</span>
      </span>
    </button>
  );
}

function ChooseStep({ onNext }: { onNext: () => void }) {
  const t = useTranslations("newsletterInbound");
  return (
    <section className="space-y-3" aria-labelledby="nl-choose-title">
      <h3 id="nl-choose-title" className="text-body font-semibold">{t("chooseTitle")}</h3>
      <PathCard icon={Inbox} title={t("pathImapTitle")} body={t("pathImapBody")} badge={t("recommended")} selected onClick={onNext} testId="nl-path-imap" />
      <PathCard icon={Cloud} title={t("pathCloudflareTitle")} body={t("pathCloudflareBody")} badge={t("comingSoon")} disabled testId="nl-path-cloudflare" />
      <PathCard icon={Webhook} title={t("pathWebhookTitle")} body={t("pathWebhookBody")} badge={t("comingSoon")} disabled testId="nl-path-webhook" />
      <p className="text-footnote text-muted-foreground">{t("tipDedicated")}</p>
      <div className="flex justify-end">
        <Button onClick={onNext} data-testid="nl-choose-next">{t("next")}</Button>
      </div>
    </section>
  );
}

function PresetHints({ preset }: { preset: PresetView | null }) {
  const t = useTranslations("newsletterInbound");
  if (!preset) return null;
  const notes: string[] = [];
  if (preset.plusAddressing === "no") notes.push(t("warnPlusNo", { label: preset.label }));
  if (preset.plusAddressing === "unverified") notes.push(t("warnPlusUnverified", { label: preset.label }));
  if (preset.imapToggle) notes.push(t("warnImapToggle", { label: preset.label }));
  if (preset.oauthOnlyRisk) notes.push(t("warnOauth"));
  if (notes.length === 0) return null;
  return (
    <ul className="space-y-1 rounded-panel bg-warning/10 p-3 text-footnote text-foreground" data-testid="nl-preset-hints">
      {notes.map((n) => (
        <li key={n} className="flex gap-2">
          <TriangleAlert className="mt-0.5 size-3.5 shrink-0 text-warning" aria-hidden />
          <span>{n}</span>
        </li>
      ))}
    </ul>
  );
}

function ConnectStep({ source, onBack, onSaved }: { source: InboundSourceView | null; onBack: () => void; onSaved: () => void | Promise<void> }) {
  const t = useTranslations("newsletterInbound");
  const errorText = useErrorText();
  const [email, setEmail] = useState(source?.address ?? "");
  const [password, setPassword] = useState("");
  const [advancedOpen, setAdvancedOpen] = useState(source?.server?.source === "manual");
  const [host, setHost] = useState(source?.server?.source === "manual" ? source.server.host : "");
  const [port, setPort] = useState(String(source?.server?.port ?? 993));
  const [secure, setSecure] = useState(source?.server?.secure ?? true);
  const [detected, setDetected] = useState<{ server: ServerView; preset: PresetView | null } | null>(source?.server ? { server: source.server, preset: source.preset } : null);
  const [detecting, setDetecting] = useState(false);
  const [notDetected, setNotDetected] = useState(false);
  const [busy, setBusy] = useState<"test" | "save" | null>(null);
  const [result, setResult] = useState<{ ok: boolean; text: string } | null>(null);
  const [confirmChange, setConfirmChange] = useState(false);
  const detectSeq = useRef(0);

  // Auto-detect the server shortly after the address stops changing.
  useEffect(() => {
    const value = email.trim();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value)) {
      setDetected(null);
      setNotDetected(false);
      return;
    }
    const seq = ++detectSeq.current;
    const timer = setTimeout(async () => {
      setDetecting(true);
      try {
        const res = await detectNewsletterImapServer({ email: value });
        if (seq !== detectSeq.current) return;
        if (res.ok) {
          setDetected({ server: res.server, preset: res.preset });
          setNotDetected(false);
        } else {
          setDetected(null);
          setNotDetected(res.code === "no-server");
          if (res.code === "no-server") setAdvancedOpen(true);
        }
      } catch {
        if (seq === detectSeq.current) setDetected(null);
      } finally {
        if (seq === detectSeq.current) setDetecting(false);
      }
    }, 500);
    return () => clearTimeout(timer);
  }, [email]);

  const payload = () => ({
    email: email.trim(),
    password: password || (source?.hasPassword ? KEEP : ""),
    ...(advancedOpen && host.trim() ? { host: host.trim(), port: Number(port) || 993, secure } : {}),
  });

  const run = async (kind: "test" | "save", confirmAddressChange = false) => {
    setBusy(kind);
    setResult(null);
    try {
      const res = kind === "test" ? await testNewsletterImap(payload()) : await saveNewsletterImap({ ...payload(), confirmAddressChange });
      if (!res.ok && res.code === "confirm-address-change") {
        setConfirmChange(true);
        return;
      }
      if (res.server) setDetected({ server: res.server, preset: res.preset ?? null });
      if (res.ok) {
        setResult({ ok: true, text: t("testOk", { count: res.folderCount }) });
        if (kind === "save") {
          toast.success(t("saved"));
          await onSaved();
        }
      } else {
        const detail = "detail" in res && res.detail && res.code === "unknown" ? ` (${res.detail})` : "";
        setResult({ ok: false, text: errorText(res.code) + detail });
      }
    } catch {
      setResult({ ok: false, text: errorText("unknown") });
    } finally {
      setBusy(null);
    }
  };

  const preset = detected?.preset ?? null;

  return (
    <section className="space-y-5" aria-labelledby="nl-connect-title">
      <h3 id="nl-connect-title" className="text-body font-semibold">{t("connectTitle")}</h3>
      {source && <p className="rounded-panel bg-info/10 p-3 text-footnote">{t("changeWarning")}</p>}

      <div className="space-y-2">
        <Label htmlFor="nl-email">{t("emailLabel")}</Label>
        <Input
          id="nl-email"
          type="email"
          inputMode="email"
          autoComplete="off"
          placeholder={t("emailPlaceholder")}
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          className="rounded-panel"
        />
        <div className="min-h-5 text-footnote text-muted-foreground" aria-live="polite" data-testid="nl-detected">
          {detecting ? (
            <span className="inline-flex items-center gap-1.5"><Loader2 className="size-3.5 animate-spin" aria-hidden />{t("detecting")}</span>
          ) : detected ? (
            <span>
              {preset ? t("detected", { label: preset.label }) + " · " : ""}
              {t("detectedServer", { host: detected.server.host, port: detected.server.port })}
            </span>
          ) : notDetected ? (
            <span>{t("notDetected")}</span>
          ) : null}
        </div>
      </div>

      <PresetHints preset={preset} />

      <div className="space-y-2">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <Label htmlFor="nl-password">{t("passwordLabel")}</Label>
          {preset && (
            <a href={preset.appPasswordUrl} target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-1 text-footnote text-link hover:underline" data-testid="nl-app-password-link">
              {t("createAppPassword")}
              <ExternalLink className="size-3.5" aria-hidden />
            </a>
          )}
        </div>
        <Input
          id="nl-password"
          type="password"
          autoComplete="new-password"
          placeholder={source?.hasPassword ? t("passwordStored") : ""}
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          className="rounded-panel"
        />
      </div>

      <Collapsible open={advancedOpen} onOpenChange={setAdvancedOpen}>
        <CollapsibleTrigger className="inline-flex items-center gap-1 text-body-sm text-muted-foreground hover:text-foreground focus-ring rounded-control">
          <ChevronDown className={cn("size-4 transition-transform duration-(--dur-fast)", advancedOpen && "rotate-180")} aria-hidden />
          {t("advanced")}
        </CollapsibleTrigger>
        <CollapsibleContent className="mt-3 space-y-3 rounded-panel border border-border/60 p-4">
          <div className="grid gap-3 sm:grid-cols-[1fr_7rem]">
            <div className="space-y-2">
              <Label htmlFor="nl-host">{t("hostLabel")}</Label>
              <Input id="nl-host" value={host} placeholder={detected?.server.host ?? "imap.example.com"} onChange={(e) => setHost(e.target.value)} className="rounded-panel" />
            </div>
            <div className="space-y-2">
              <Label htmlFor="nl-port">{t("portLabel")}</Label>
              <Input id="nl-port" inputMode="numeric" value={port} onChange={(e) => setPort(e.target.value.replace(/[^\d]/g, "").slice(0, 5))} className="rounded-panel" />
            </div>
          </div>
          <div className="flex items-start justify-between gap-4">
            <div>
              <Label htmlFor="nl-secure">{t("secureLabel")}</Label>
              <p className="text-footnote text-muted-foreground">{t("secureHint")}</p>
            </div>
            <Switch id="nl-secure" checked={secure} onCheckedChange={setSecure} />
          </div>
        </CollapsibleContent>
      </Collapsible>

      {result && (
        <p
          role={result.ok ? "status" : "alert"}
          data-testid="nl-connect-result"
          className={cn("flex items-start gap-2 rounded-panel p-3 text-body-sm", result.ok ? "bg-success/10 text-success" : "bg-danger/10 text-danger")}
        >
          {result.ok ? <CheckCircle2 className="mt-0.5 size-4 shrink-0" aria-hidden /> : <TriangleAlert className="mt-0.5 size-4 shrink-0" aria-hidden />}
          <span>{result.text}</span>
        </p>
      )}

      <AlertDialog open={confirmChange} onOpenChange={setConfirmChange}>
        <AlertDialogContent data-testid="nl-confirm-change">
          <AlertDialogHeader>
            <AlertDialogTitle>{t("confirmChangeTitle")}</AlertDialogTitle>
            <AlertDialogDescription>{t("confirmChangeBody")}</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{t("cancel")}</AlertDialogCancel>
            <AlertDialogAction
              data-testid="nl-confirm-change-ok"
              onClick={() => {
                setConfirmChange(false);
                void run("save", true);
              }}
            >
              {t("confirmChangeOk")}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <div className="flex flex-wrap justify-between gap-2">
        <Button variant="ghost" onClick={onBack} disabled={busy !== null}>{t("back")}</Button>
        <div className="flex flex-wrap gap-2">
          <Button variant="outline" onClick={() => run("test")} disabled={busy !== null || !email.trim()} data-testid="nl-test-connection">
            {busy === "test" && <Loader2 className="size-4 animate-spin" aria-hidden />}
            {busy === "test" ? t("testing") : t("testConnection")}
          </Button>
          <Button onClick={() => run("save")} disabled={busy !== null || !email.trim()} data-testid="nl-save">
            {busy === "save" && <Loader2 className="size-4 animate-spin" aria-hidden />}
            {busy === "save" ? t("saving") : t("saveAndContinue")}
          </Button>
        </div>
      </div>
    </section>
  );
}

function CopyButton({ value, testId }: { value: string; testId?: string }) {
  const t = useTranslations("newsletterInbound");
  const [copied, setCopied] = useState(false);
  return (
    <Button
      variant="outline"
      size="sm"
      data-testid={testId}
      onClick={async () => {
        try {
          await navigator.clipboard.writeText(value);
          setCopied(true);
          setTimeout(() => setCopied(false), 2000);
        } catch {
          toast.error(t("errors.unknown"));
        }
      }}
    >
      <Copy className="size-4" aria-hidden />
      {copied ? t("copied") : t("copy")}
    </Button>
  );
}

function TestStep({ mailAvailable, onDone }: { mailAvailable: boolean; onDone: () => void | Promise<void> }) {
  const t = useTranslations("newsletterInbound");
  const errorText = useErrorText();
  const [phase, setPhase] = useState<"idle" | "sending" | "waiting" | "arrived" | "timeout" | "failed">("idle");
  const [address, setAddress] = useState<string | null>(null);
  const [marker, setMarker] = useState<string | null>(null);
  const [since, setSince] = useState<string | null>(null);
  const [elapsed, setElapsed] = useState(0);
  const [arrivedIn, setArrivedIn] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [lastPollError, setLastPollError] = useState<string | null>(null);

  // Without a mailer: fetch the address + this test's subject marker right away.
  useEffect(() => {
    if (mailAvailable) return;
    let cancelled = false;
    void startNewsletterTest({ send: false })
      .then((res) => {
        if (cancelled) return;
        if (res.ok) {
          setAddress(res.address);
          setMarker(res.marker);
          setSince(res.startedAt);
        } else setError(errorText(res.code));
      })
      .catch(() => !cancelled && setError(errorText("unknown")));
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mailAvailable]);

  // Live status: poll the mailbox every few seconds until the marked mail arrives.
  useEffect(() => {
    if (phase !== "waiting" || !since || !marker) return;
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const started = Date.now();
    const tick = setInterval(() => setElapsed(Math.round((Date.now() - started) / 1000)), 1000);
    const poll = async () => {
      try {
        const res = await checkNewsletterTestMail({ since, marker });
        if (cancelled) return;
        setLastPollError(res.errorCode);
        if (res.arrived) {
          setArrivedIn(res.seconds ?? Math.round((Date.now() - started) / 1000));
          setPhase("arrived");
          return;
        }
        // Waiting longer will not fix a wrong password or a disabled IMAP.
        if (res.errorCode && FATAL_POLL_ERRORS.has(res.errorCode)) {
          setPhase("failed");
          return;
        }
      } catch {
        /* transient: try again */
      }
      if (cancelled) return;
      if (Date.now() - started > POLL_FOR_MS) {
        setPhase("timeout");
        return;
      }
      timer = setTimeout(poll, POLL_EVERY_MS);
    };
    timer = setTimeout(poll, 1500);
    return () => {
      cancelled = true;
      clearInterval(tick);
      if (timer) clearTimeout(timer);
    };
  }, [phase, since, marker]);

  const send = async () => {
    setError(null);
    setLastPollError(null);
    setPhase("sending");
    try {
      const res = await startNewsletterTest({ send: true });
      if (res.address) setAddress(res.address);
      if (!res.ok) {
        setError(errorText(res.code));
        setPhase("idle");
        return;
      }
      setMarker(res.marker);
      setSince(res.startedAt);
      setElapsed(0);
      setPhase("waiting");
    } catch {
      setError(errorText("unknown"));
      setPhase("idle");
    }
  };

  const startManual = () => {
    setError(null);
    setLastPollError(null);
    setElapsed(0);
    setPhase("waiting");
  };

  return (
    <section className="space-y-5" aria-labelledby="nl-test-title" data-testid="nl-test-step">
      <div className="space-y-1">
        <h3 id="nl-test-title" className="text-body font-semibold">{t("testTitle")}</h3>
        <p className="text-body-sm text-muted-foreground">{t("testIntro")}</p>
      </div>

      {!mailAvailable && address && marker && (
        <div className="space-y-3 rounded-panel border border-border/60 p-4">
          <p className="text-body-sm">{t("manualTest")}</p>
          <dl className="grid gap-2 text-body-sm sm:grid-cols-[auto_1fr] sm:items-center">
            <dt className="text-muted-foreground">{t("manualTo")}</dt>
            <dd className="flex flex-wrap items-center gap-2">
              <code className="min-w-0 break-all rounded-control bg-surface-sunken px-2 py-1 text-body-sm" data-testid="nl-test-address">{address}</code>
              <CopyButton value={address} />
            </dd>
            <dt className="text-muted-foreground">{t("manualSubject")}</dt>
            <dd className="flex flex-wrap items-center gap-2">
              <code className="rounded-control bg-surface-sunken px-2 py-1 text-body-sm" data-testid="nl-test-marker">{marker}</code>
              <CopyButton value={marker} />
            </dd>
          </dl>
        </div>
      )}

      <div className="rounded-panel border border-border/60 p-4" aria-live="polite" data-testid="nl-test-status">
        {phase === "idle" && <p className="text-body-sm text-muted-foreground">{t("testIdle")}</p>}
        {phase === "sending" && <p className="flex items-center gap-2 text-body-sm"><Loader2 className="size-4 animate-spin" aria-hidden />{t("sendingTestMail")}</p>}
        {phase === "waiting" && (
          <p className="flex items-center gap-2 text-body-sm">
            <Loader2 className="size-4 animate-spin" aria-hidden />
            {t("waiting", { seconds: elapsed })}
          </p>
        )}
        {phase === "arrived" && (
          <p className="flex items-center gap-2 text-body-sm font-semibold text-success" data-testid="nl-test-arrived">
            <CheckCircle2 className="size-4" aria-hidden />
            {t("arrived", { seconds: arrivedIn ?? 0 })}
          </p>
        )}
        {phase === "timeout" && <p className="text-body-sm text-warning">{t("waitingLong")}</p>}
        {phase === "failed" && <p className="text-body-sm text-danger" data-testid="nl-test-failed">{t("testFailed")}</p>}
        {lastPollError && phase !== "arrived" && <p className="mt-2 text-footnote text-danger">{errorText(lastPollError)}</p>}
        {error && <p role="alert" className="mt-2 text-footnote text-danger">{error}</p>}
      </div>

      <div className="flex flex-wrap justify-between gap-2">
        <Button variant="ghost" onClick={() => onDone()} data-testid="nl-test-skip">{phase === "arrived" ? t("done") : t("skipTest")}</Button>
        {phase !== "arrived" && (
          mailAvailable ? (
            <Button onClick={send} disabled={phase === "sending" || phase === "waiting"} data-testid="nl-send-test">
              <Send className="size-4" aria-hidden />
              {t("sendTestMail")}
            </Button>
          ) : (
            <Button onClick={startManual} disabled={phase === "waiting" || !marker} data-testid="nl-manual-sent">
              <Mail className="size-4" aria-hidden />
              {t("startWaiting")}
            </Button>
          )
        )}
      </div>
    </section>
  );
}

function StatusCard({ source, onEdit, onTest, onChanged, onDisconnected }: {
  source: InboundSourceView;
  onEdit: () => void;
  onTest: () => void;
  onChanged: (source: InboundSourceView) => void;
  onDisconnected: () => void | Promise<void>;
}) {
  const t = useTranslations("newsletterInbound");
  const errorText = useErrorText();
  const format = useFormatter();
  const [busy, setBusy] = useState(false);
  const [confirm, setConfirm] = useState(false);
  const status = source.paused ? "paused" : source.errorCount > 0 ? "error" : "ok";
  const when = (iso: string | null) => (iso ? format.relativeTime(new Date(iso)) : t("never"));

  const togglePause = async () => {
    setBusy(true);
    try {
      const res = await setNewsletterInboundPaused({ paused: !source.paused });
      if (res.ok && res.source) onChanged(res.source);
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="space-y-4 rounded-panel border border-border/60 bg-card p-5" data-testid="nl-status-card" aria-labelledby="nl-status-title">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h3 id="nl-status-title" className="text-body font-semibold">{t("statusTitle")}</h3>
        <span
          data-testid="nl-status-badge"
          className={cn(
            "rounded-full px-2.5 py-0.5 text-footnote font-medium",
            status === "ok" ? "bg-success/10 text-success" : status === "paused" ? "bg-muted text-muted-foreground" : "bg-danger/10 text-danger",
          )}
        >
          {t(`status.${status}`)}
        </span>
      </div>
      <dl className="grid gap-x-6 gap-y-2 text-body-sm sm:grid-cols-[auto_1fr]">
        <dt className="text-muted-foreground">{t("statusPath")}</dt>
        <dd>{t("pathImap")}{source.preset ? ` · ${source.preset.label}` : ""}</dd>
        <dt className="text-muted-foreground">{t("statusMailbox")}</dt>
        <dd className="break-all">{source.address}</dd>
        <dt className="text-muted-foreground">{t("lastMail")}</dt>
        <dd data-testid="nl-last-mail">{when(source.lastReceivedAt)}</dd>
        <dt className="text-muted-foreground">{t("lastCheck")}</dt>
        <dd>{when(source.lastCheckedAt)}</dd>
        <dt className="text-muted-foreground">{t("errorCount")}</dt>
        <dd className="tabular-nums" data-testid="nl-error-count">{source.errorCount}</dd>
        {source.lastErrorCode && (
          <>
            <dt className="text-muted-foreground">{t("lastError")}</dt>
            <dd className="text-danger">{errorText(source.lastErrorCode)}</dd>
          </>
        )}
      </dl>
      <div className="flex flex-wrap gap-2">
        <Button variant="outline" size="sm" onClick={onTest} data-testid="nl-status-test">{t("runTest")}</Button>
        <Button variant="outline" size="sm" onClick={onEdit} data-testid="nl-status-edit">{t("edit")}</Button>
        <Button variant="outline" size="sm" onClick={togglePause} disabled={busy} data-testid="nl-status-pause">{source.paused ? t("resume") : t("pause")}</Button>
        <Button variant="ghost" size="sm" className="text-danger" onClick={() => setConfirm(true)} data-testid="nl-status-disconnect">{t("disconnect")}</Button>
      </div>

      <AlertDialog open={confirm} onOpenChange={setConfirm}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{t("disconnectTitle")}</AlertDialogTitle>
            <AlertDialogDescription>{t("disconnectBody")}</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{t("cancel")}</AlertDialogCancel>
            <AlertDialogAction
              data-testid="nl-disconnect-confirm"
              onClick={async () => {
                const res = await disconnectNewsletterInbound({ confirm: true });
                if (res.ok) await onDisconnected();
              }}
            >
              {t("disconnect")}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </section>
  );
}
