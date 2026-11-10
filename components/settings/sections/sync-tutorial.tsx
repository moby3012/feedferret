"use client";

import { useTranslations } from "next-intl";
import { ExternalLink, Rss, ChevronDown, ChevronRight } from "lucide-react";
import { cn } from "@/lib/utils";
import { useState, useEffect } from "react";

type SyncClient = {
  name: string;
  platforms: string;
  url: string;
  api: "greader" | "opml";
  serverField: string;
  notesKey?: string;
};

const SYNC_CLIENTS: SyncClient[] = [
  {
    name: "Reeder 5 / Classic",
    platforms: "macOS, iOS, iPadOS",
    url: "https://reederapp.com/",
    api: "greader",
    serverField: "FreshRSS / FeedHQ",
    notesKey: "syncReaders.clients.reeder5.notes",
  },
  {
    name: "NetNewsWire",
    platforms: "macOS, iOS",
    url: "https://netnewswire.com/",
    api: "greader",
    serverField: "FreshRSS",
    notesKey: "syncReaders.clients.netnewswire.notes",
  },
  {
    name: "ReadKit",
    platforms: "macOS, iOS",
    url: "https://readkit.app/",
    api: "greader",
    serverField: "Fever / FreshRSS",
    notesKey: "syncReaders.clients.readkit.notes",
  },
  {
    name: "Fluent Reader",
    platforms: "Windows, macOS, Linux",
    url: "https://hyliu.me/fluent-reader/",
    api: "greader",
    serverField: "FreshRSS",
    notesKey: "syncReaders.clients.fluentreader.notes",
  },
  {
    name: "FeedMe",
    platforms: "Android",
    url: "https://play.google.com/store/apps/details?id=com.seazon.feedme",
    api: "greader",
    serverField: "Custom Google Reader API",
    notesKey: "syncReaders.clients.feedme.notes",
  },
  {
    name: "News+",
    platforms: "Android",
    url: "https://noinnion.com/newsplus/",
    api: "greader",
    serverField: "GReader compatible",
    notesKey: "syncReaders.clients.newsplus.notes",
  },
  {
    name: "Feedly",
    platforms: "Web, iOS, Android",
    url: "https://feedly.com/",
    api: "opml",
    serverField: "OPML import / export",
    notesKey: "syncReaders.clients.feedly.notes",
  },
  {
    name: "Inoreader",
    platforms: "Web, iOS, Android",
    url: "https://www.inoreader.com/",
    api: "opml",
    serverField: "OPML import / export",
    notesKey: "syncReaders.clients.inoreader.notes",
  },
];

export function SyncTutorialSection() {
  const t = useTranslations();
  const [open, setOpen] = useState(false);
  const [instanceUrl, setInstanceUrl] = useState<string>("");

  useEffect(() => {
    if (typeof window === "undefined") return;
    setInstanceUrl(window.location.origin);
  }, []);

  const greaderUrl = `${instanceUrl || "https://your-feedferret"}/api/greader`;
  const apiUrl = `${instanceUrl || "https://your-feedferret"}/api/v1`;

  return (
    <section className="rounded-2xl border border-border/65 bg-card/85 p-5 shadow-sm sm:p-6">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        className="flex w-full items-start gap-4 text-start"
      >
        <div className="ui-brand-icon flex h-12 w-12 shrink-0 items-center justify-center rounded-2xl">
          <Rss className="h-5 w-5" />
        </div>
        <div className="flex-1 min-w-0">
          <h2 className="text-lg font-semibold tracking-title">{t("syncReaders.title")}</h2>
          <p className="mt-1 max-w-2xl text-sm leading-6 text-muted-foreground">
            {t("syncReaders.description")}
          </p>
        </div>
        <span className="mt-1 inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-xl text-muted-foreground">
          {open ? <ChevronDown className="h-4 w-4" /> : <ChevronRight className="h-4 w-4" />}
        </span>
      </button>

      {open && (
        <div className="animate-fade-in-up mt-6 space-y-6">
          <div className="grid gap-3 sm:grid-cols-2">
            <div className="ui-control-surface rounded-2xl border p-4">
              <p className="text-xs font-medium uppercase tracking-wider text-muted-foreground">{t("syncReaders.greaderEndpoint")}</p>
              <p className="mt-1 break-all text-sm font-mono">{greaderUrl}</p>
              <p className="mt-2 text-xs text-muted-foreground">
                {t("syncReaders.greaderUsernameHint")}
              </p>
            </div>
            <div className="ui-control-surface rounded-2xl border p-4">
              <p className="text-xs font-medium uppercase tracking-wider text-muted-foreground">{t("syncReaders.restApiBase")}</p>
              <p className="mt-1 break-all text-sm font-mono">{apiUrl}</p>
              <p className="mt-2 text-xs text-muted-foreground">
                {t("syncReaders.restApiHint")}
              </p>
            </div>
          </div>

          <div className="space-y-3">
            {SYNC_CLIENTS.map((client) => (
              <div
                key={client.name}
                className="ui-control-surface rounded-2xl border p-4"
              >
                <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
                  <div className="min-w-0">
                    <div className="flex flex-wrap items-center gap-2">
                      <p className="text-sm font-semibold">{client.name}</p>
                      <span className="rounded-full bg-muted px-2 py-0.5 text-caption font-medium text-muted-foreground">
                        {client.platforms}
                      </span>
                      <span
                        className={cn(
                          "rounded-full px-2 py-0.5 text-caption font-medium",
                          client.api === "greader"
                            ? "bg-success/10 text-success"
                            : "bg-warning/10 text-warning",
                        )}
                      >
                        {client.api === "greader" ? t("syncReaders.directSync") : t("syncReaders.opmlOnly")}
                      </span>
                    </div>
                    {client.notesKey && (
                      <p className="mt-1 text-xs text-muted-foreground leading-relaxed">{t(client.notesKey as any)}</p>
                    )}
                  </div>
                  <a
                    href={client.url}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="inline-flex shrink-0 items-center gap-1 rounded-xl border border-border/60 bg-background px-3 py-1.5 text-xs font-medium hover:bg-muted/60 transition-colors"
                  >
                    {t("syncReaders.openSite")}
                    <ExternalLink className="h-3 w-3" />
                  </a>
                </div>
                {client.api === "greader" && (
                  <p className="mt-3 text-caption text-muted-foreground">
                    {t("syncReaders.inClientChoose")} <strong>{client.serverField}</strong> and paste <code className="rounded bg-background/80 px-1 font-mono">{greaderUrl}</code> {t("syncReaders.serverUrl")}
                  </p>
                )}
              </div>
            ))}
          </div>

          <div className="rounded-2xl border border-warning/20 bg-warning/5 p-4 text-xs text-muted-foreground leading-relaxed">
            <p className="font-medium text-warning mb-1">{t("syncReaders.twoFactorNote")}</p>
            <p>
              {t("syncReaders.twoFactorNoteBody")}
            </p>
          </div>
        </div>
      )}
    </section>
  );
}
