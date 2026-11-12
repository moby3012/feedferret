"use client";

// N1 PR C: wizard step 2 for the webhook ways — "Eigene Domain über Cloudflare"
// (worker script with URL + secret filled in) and "Mail-Dienst mit Webhook"
// (Postmark / Mailgun). The secret comes back from the server exactly once and
// lives only in this component's state; it is never stored in the browser.

import { useMemo, useState } from "react";
import { useTranslations } from "next-intl";
import { toast } from "sonner";
import { CheckCircle2, Loader2, TriangleAlert } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
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
import { renderCloudflareEmailWorker } from "@/lib/cloudflare-email-worker";
import { saveNewsletterDomainSource, type InboundSourceView } from "@/app/actions/newsletter-admin";
import { CopyButton } from "@/components/newsletter/copy-button";
import type { WebhookKind } from "@/lib/newsletter-constants";

const BASIC_AUTH_USER = "feedferret";

/** Public endpoint of a source: this page's origin + the source's path. */
export function webhookUrl(path: string, secret?: string): string {
  const url = new URL(path, window.location.origin);
  if (secret) {
    url.username = BASIC_AUTH_USER;
    url.password = secret;
  }
  return url.toString();
}

function Steps({ items, testId }: { items: string[]; testId?: string }) {
  return (
    <ol className="list-decimal space-y-2 ps-5 text-body-sm" data-testid={testId}>
      {items.map((item) => (
        <li key={item}>{item}</li>
      ))}
    </ol>
  );
}

function CopyField({ label, value, testId, secret }: { label: string; value: string; testId: string; secret?: boolean }) {
  return (
    <div className="space-y-1.5">
      <p className="text-body-sm font-medium">{label}</p>
      <div className="flex flex-wrap items-center gap-2">
        <code
          className="min-w-0 flex-1 break-all rounded-control bg-surface-sunken px-2 py-1.5 text-footnote"
          data-testid={testId}
          data-secret={secret ? "1" : undefined}
        >
          {value}
        </code>
        <CopyButton value={value} testId={`${testId}-copy`} label={label} />
      </div>
    </div>
  );
}

function CloudflareSetup({ path, secret, domain }: { path: string; secret: string; domain: string }) {
  const t = useTranslations("newsletterInbound");
  const script = useMemo(() => renderCloudflareEmailWorker(webhookUrl(path), secret), [path, secret]);
  return (
    <div className="space-y-4" data-testid="nl-setup-cloudflare">
      <h4 className="text-body-sm font-semibold">{t("setupCloudflareTitle")}</h4>
      <Steps items={[t("cfStep1", { domain }), t("cfStep2"), t("cfStep3"), t("cfStep4")]} testId="nl-cf-steps" />
      <div className="space-y-2">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <p className="text-body-sm font-medium">{t("scriptTitle")}</p>
          <CopyButton value={script} testId="nl-worker-script-copy" label={t("scriptTitle")} />
        </div>
        <pre
          tabIndex={0}
          className="max-h-72 overflow-auto rounded-panel bg-surface-sunken p-3 text-footnote leading-relaxed focus-ring"
          data-testid="nl-worker-script"
        >
          {script}
        </pre>
        <p className="text-footnote text-muted-foreground">{t("scriptHint")}</p>
      </div>
    </div>
  );
}

function WebhookSetup({ path, secret, domain }: { path: string; secret: string; domain: string }) {
  const t = useTranslations("newsletterInbound");
  return (
    <div className="space-y-5" data-testid="nl-setup-webhook">
      <CopyField label={t("webhookUrlAuth")} value={webhookUrl(path, secret)} testId="nl-webhook-url-auth" secret />
      <CopyField label={t("webhookUrlPlain")} value={webhookUrl(path)} testId="nl-webhook-url" />
      <p className="text-footnote text-muted-foreground">{t("webhookAuthHint")}</p>
      <div className="space-y-2">
        <h4 className="text-body-sm font-semibold">Postmark</h4>
        <Steps items={[t("postmarkStep1"), t("postmarkStep2", { domain })]} />
      </div>
      <div className="space-y-2">
        <h4 className="text-body-sm font-semibold">Mailgun</h4>
        <Steps items={[t("mailgunStep1", { domain }), t("mailgunStep2"), t("mailgunStep3")]} />
      </div>
    </div>
  );
}

export function DomainConnectStep({ way, source, onBack, onSaved }: {
  way: WebhookKind;
  source: InboundSourceView | null;
  onBack: () => void;
  onSaved: () => void | Promise<void>;
}) {
  const t = useTranslations("newsletterInbound");
  const errorText = (code: string) => t(`errors.${code}`);
  // Setting up the same way again is a rotation; only then is there an old secret to warn about.
  const existing = source && source.kind === way ? source : null;
  const [domain, setDomain] = useState(existing?.address ?? "");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [confirmChange, setConfirmChange] = useState(false);
  const [revealed, setRevealed] = useState<{ secret: string; path: string; domain: string } | null>(null);

  const run = async (confirmAddressChange = false) => {
    setBusy(true);
    setError(null);
    try {
      const res = await saveNewsletterDomainSource({ kind: way, domain: domain.trim(), confirmAddressChange });
      if (!res.ok) {
        if (res.code === "confirm-address-change") setConfirmChange(true);
        else setError(errorText(res.code));
        return;
      }
      toast.success(t("saved"));
      setRevealed({ secret: res.secret, path: res.source.webhookPath ?? "", domain: res.source.address ?? domain.trim() });
    } catch {
      setError(errorText("unknown"));
    } finally {
      setBusy(false);
    }
  };

  const insecure = typeof window !== "undefined" && window.location.protocol === "http:" && !["localhost", "127.0.0.1", "[::1]"].includes(window.location.hostname);

  if (revealed) {
    return (
      <section className="space-y-5" aria-labelledby="nl-setup-title" data-testid="nl-domain-setup">
        <div className="space-y-1">
          <h3 id="nl-setup-title" className="text-body font-semibold">{t(way === "cloudflare" ? "setupCloudflareHeading" : "setupWebhookHeading")}</h3>
          <p className="flex items-start gap-2 rounded-panel bg-warning/10 p-3 text-footnote" role="status" data-testid="nl-secret-once">
            <TriangleAlert className="mt-0.5 size-3.5 shrink-0 text-warning" aria-hidden />
            <span>{t("secretOnce")}</span>
          </p>
        </div>
        <p className="text-body-sm text-muted-foreground">{t("addressExample", { example: `abcd…@${revealed.domain}` })}</p>
        {way === "cloudflare" ? (
          <CloudflareSetup path={revealed.path} secret={revealed.secret} domain={revealed.domain} />
        ) : (
          <WebhookSetup path={revealed.path} secret={revealed.secret} domain={revealed.domain} />
        )}
        <div className="flex justify-end">
          <Button onClick={() => onSaved()} data-testid="nl-setup-continue">{t("continueToTest")}</Button>
        </div>
      </section>
    );
  }

  return (
    <section className="space-y-5" aria-labelledby="nl-connect-title">
      <h3 id="nl-connect-title" className="text-body font-semibold">{t(way === "cloudflare" ? "connectCloudflareTitle" : "connectWebhookTitle")}</h3>
      {source && source.kind !== way && <p className="rounded-panel bg-info/10 p-3 text-footnote">{t("changeWarning")}</p>}
      {existing && <p className="rounded-panel bg-info/10 p-3 text-footnote" data-testid="nl-rotate-warning">{t("rotateWarning")}</p>}
      {insecure && <p className="rounded-panel bg-warning/10 p-3 text-footnote" data-testid="nl-http-warning">{t("httpWarning")}</p>}

      <div className="space-y-2">
        <Label htmlFor="nl-domain">{t("domainLabel")}</Label>
        <Input
          id="nl-domain"
          inputMode="url"
          autoComplete="off"
          autoCapitalize="none"
          spellCheck={false}
          placeholder={t("domainPlaceholder")}
          value={domain}
          onChange={(e) => setDomain(e.target.value)}
          className="rounded-panel"
        />
        <p className="text-footnote text-muted-foreground">{t(way === "cloudflare" ? "domainHintCloudflare" : "domainHintWebhook")}</p>
      </div>

      {error && (
        <p role="alert" data-testid="nl-connect-result" className="flex items-start gap-2 rounded-panel bg-danger/10 p-3 text-body-sm text-danger">
          <TriangleAlert className="mt-0.5 size-4 shrink-0" aria-hidden />
          <span>{error}</span>
        </p>
      )}

      <AlertDialog open={confirmChange} onOpenChange={setConfirmChange}>
        <AlertDialogContent data-testid="nl-confirm-change">
          <AlertDialogHeader>
            <AlertDialogTitle>{t("confirmChangeDomainTitle")}</AlertDialogTitle>
            <AlertDialogDescription>{t("confirmChangeDomainBody")}</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{t("cancel")}</AlertDialogCancel>
            <AlertDialogAction
              data-testid="nl-confirm-change-ok"
              onClick={() => {
                setConfirmChange(false);
                void run(true);
              }}
            >
              {t("confirmChangeOk")}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <div className="flex flex-wrap justify-between gap-2">
        <Button variant="ghost" onClick={onBack} disabled={busy}>{t("back")}</Button>
        <Button onClick={() => run()} disabled={busy || !domain.trim()} data-testid="nl-save">
          {busy ? <Loader2 className="size-4 animate-spin" aria-hidden /> : <CheckCircle2 className="size-4" aria-hidden />}
          {busy ? t("generating") : t(existing ? "rotateSecret" : "generateSecret")}
        </Button>
      </div>
    </section>
  );
}
