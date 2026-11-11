"use client";

// N1 PR B: Einstellungen → Newsletter (spec §10). One big address to copy or
// share, optional extra addresses per newsletter, deactivate per address.
// Explains itself when the admin has not set up the inbox yet.

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { useFormatter, useTranslations } from "next-intl";
import { toast } from "sonner";
import { Copy, Inbox, Loader2, Mail, Plus, Share2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { cn } from "@/lib/utils";
import {
  createMyNewsletterAddress,
  getMyNewsletterInbox,
  setMyNewsletterAddressActive,
  type NewsletterInboxView,
} from "@/app/actions/newsletter";

function useCopy() {
  const t = useTranslations("newsletterSettings");
  const [copied, setCopied] = useState<string | null>(null);
  const copy = async (value: string) => {
    try {
      await navigator.clipboard.writeText(value);
      setCopied(value);
      toast.success(t("copied"));
      setTimeout(() => setCopied((c) => (c === value ? null : c)), 2000);
    } catch {
      toast.error(t("errors.generic"));
    }
  };
  return { copied, copy };
}

export function NewsletterSettings() {
  const t = useTranslations("newsletterSettings");
  const format = useFormatter();
  const [inbox, setInbox] = useState<NewsletterInboxView | null>(null);
  const [failed, setFailed] = useState(false);
  const [label, setLabel] = useState("");
  const [creating, setCreating] = useState(false);
  const [busyId, setBusyId] = useState<string | null>(null);
  const { copied, copy } = useCopy();

  const load = useCallback(async () => {
    try {
      setInbox(await getMyNewsletterInbox());
      setFailed(false);
    } catch {
      setFailed(true);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  if (failed) return <p className="text-body-sm text-danger">{t("errors.generic")}</p>;
  if (!inbox) {
    return (
      <div className="flex items-center justify-center py-12">
        <Loader2 className="size-6 animate-spin text-muted-foreground" aria-hidden />
      </div>
    );
  }

  if (!inbox.available) {
    return (
      <section className="rounded-panel border border-border/65 bg-card/85 p-5 sm:p-6" data-testid="newsletter-unavailable">
        <div className="flex items-start gap-4">
          <div className="ui-brand-icon flex size-12 shrink-0 items-center justify-center rounded-panel">
            <Inbox className="size-5" aria-hidden />
          </div>
          <div className="space-y-2">
            <h3 className="text-title-sm font-semibold tracking-title">{t("unavailableTitle")}</h3>
            <p className="text-body-sm leading-6 text-muted-foreground">{inbox.isAdmin ? t("unavailableAdminBody") : t("unavailableBody")}</p>
            {inbox.isAdmin && (
              <Button asChild size="sm">
                <Link href="/server-settings?tab=newsletter" data-testid="newsletter-setup-link">{t("setupCta")}</Link>
              </Button>
            )}
          </div>
        </div>
      </section>
    );
  }

  const primary = inbox.addresses.find((a) => a.isPrimary) ?? inbox.addresses[0];
  const extras = inbox.addresses.filter((a) => a.id !== primary?.id);

  const share = async (address: string) => {
    if (typeof navigator.share === "function") {
      try {
        await navigator.share({ title: t("shareTitle"), text: address });
        return;
      } catch (error) {
        if ((error as Error)?.name === "AbortError") return;
      }
    }
    await copy(address);
  };

  const create = async () => {
    setCreating(true);
    try {
      const res = await createMyNewsletterAddress({ description: label });
      if (res.ok) {
        setInbox(res.inbox);
        setLabel("");
        toast.success(t("created"));
      } else {
        toast.error(res.error === "limit" ? t("errors.limit", { limit: inbox.limit }) : t("errors.generic"));
      }
    } catch {
      toast.error(t("errors.generic"));
    } finally {
      setCreating(false);
    }
  };

  const toggle = async (id: string, active: boolean) => {
    setBusyId(id);
    try {
      const res = await setMyNewsletterAddressActive({ id, active });
      if (res.ok && res.inbox) setInbox(res.inbox);
      else toast.error(res.error === "last-active" ? t("errors.lastActive") : t("errors.generic"));
    } catch {
      toast.error(t("errors.generic"));
    } finally {
      setBusyId(null);
    }
  };

  return (
    <>
      <section className="rounded-panel border border-border/65 bg-card/85 p-5 sm:p-6" data-testid="newsletter-primary">
        <div className="flex items-start gap-4">
          <div className="ui-brand-icon flex size-12 shrink-0 items-center justify-center rounded-panel">
            <Mail className="size-5" aria-hidden />
          </div>
          <div className="min-w-0">
            <h3 className="text-title-sm font-semibold tracking-title">{t("title")}</h3>
            <p className="mt-1 text-body-sm leading-6 text-muted-foreground">{t("description")}</p>
          </div>
        </div>
        {inbox.paused && <p className="mt-4 rounded-panel bg-warning/10 p-3 text-footnote">{t("pausedNote")}</p>}
        {primary && (
          <div className="mt-5 space-y-3">
            <p className="break-all rounded-panel bg-surface-sunken px-4 py-3 font-mono text-body font-semibold select-all" data-testid="newsletter-address">
              {primary.address}
            </p>
            <div className="flex flex-wrap gap-2">
              <Button onClick={() => copy(primary.address)} data-testid="newsletter-copy">
                <Copy className="size-4" aria-hidden />
                {copied === primary.address ? t("copied") : t("copy")}
              </Button>
              <Button variant="outline" onClick={() => share(primary.address)} data-testid="newsletter-share">
                <Share2 className="size-4" aria-hidden />
                {t("share")}
              </Button>
            </div>
          </div>
        )}
      </section>

      <section className="rounded-panel border border-border/65 bg-card/85 p-5 sm:p-6" aria-labelledby="newsletter-extra-title">
        <h3 id="newsletter-extra-title" className="text-body font-semibold">{t("perNewsletterTitle")}</h3>
        <p className="mt-1 text-body-sm text-muted-foreground">{t("perNewsletterBody")}</p>
        <div className="mt-4 flex flex-col gap-2 sm:flex-row sm:items-end">
          <div className="flex-1 space-y-2">
            <Label htmlFor="newsletter-label" className="sr-only">{t("labelPlaceholder")}</Label>
            <Input
              id="newsletter-label"
              value={label}
              maxLength={80}
              placeholder={t("labelPlaceholder")}
              onChange={(e) => setLabel(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && !creating) void create();
              }}
              className="rounded-panel"
            />
          </div>
          <Button onClick={create} disabled={creating} data-testid="newsletter-create">
            {creating ? <Loader2 className="size-4 animate-spin" aria-hidden /> : <Plus className="size-4" aria-hidden />}
            {t("create")}
          </Button>
        </div>

        {inbox.addresses.length > 0 && (
          <ul className="mt-5 divide-y divide-border/60" data-testid="newsletter-address-list">
            {[...(primary ? [primary] : []), ...extras].map((a) => (
              <li key={a.id} className="flex flex-col gap-2 py-3 sm:flex-row sm:items-center sm:justify-between" data-testid="newsletter-address-row" data-active={a.isActive ? "1" : "0"}>
                <div className="min-w-0 space-y-0.5">
                  <p className={cn("break-all font-mono text-body-sm", !a.isActive && "text-muted-foreground line-through")}>{a.address}</p>
                  <p className="text-footnote text-muted-foreground">
                    {[
                      a.isPrimary ? t("primary") : null,
                      a.description,
                      !a.isActive ? t("inactive") : null,
                      a.lastReceivedAt ? t("lastMail", { when: format.relativeTime(new Date(a.lastReceivedAt)) }) : t("noMailYet"),
                    ]
                      .filter(Boolean)
                      .join(" · ")}
                  </p>
                </div>
                <div className="flex shrink-0 gap-2">
                  {a.isActive && (
                    <Button variant="outline" size="sm" onClick={() => copy(a.address)} aria-label={`${t("copy")}: ${a.address}`}>
                      <Copy className="size-4" aria-hidden />
                    </Button>
                  )}
                  <Button variant="ghost" size="sm" disabled={busyId === a.id} onClick={() => toggle(a.id, !a.isActive)} data-testid="newsletter-toggle">
                    {a.isActive ? t("deactivate") : t("activate")}
                  </Button>
                </div>
              </li>
            ))}
          </ul>
        )}
      </section>
    </>
  );
}
