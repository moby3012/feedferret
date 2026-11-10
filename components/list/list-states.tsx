"use client";

import Link from "next/link";
import type { ReactNode } from "react";
import { useTranslations } from "next-intl";
import { AlertCircle, Archive, Bookmark, CloudOff, Compass, FileUp, Inbox, Plus, RotateCw, Rss, Star, Tag, WifiOff, type LucideIcon } from "lucide-react";
import { Button } from "@/components/ui/button";

// List states (audit A-01): what the list shows instead of rows. Each one makes
// a TRUE statement about the user's data — a failed load is never "caught up",
// an empty Gemerkt is never "Du bist auf dem Laufenden".

function StateFrame({ icon: Icon, title, description, tone = "muted", children, testId }: {
  icon: LucideIcon;
  title: string;
  description: string;
  tone?: "muted" | "warn";
  children?: ReactNode;
  testId: string;
}) {
  return (
    <section
      data-testid={testId}
      aria-labelledby={`${testId}-title`}
      className="mx-auto flex max-w-sm flex-col items-center gap-3 px-6 py-16 text-center"
    >
      <span
        className={
          tone === "warn"
            ? "flex size-11 items-center justify-center rounded-full bg-warning-subtle text-warning"
            : "flex size-11 items-center justify-center rounded-full bg-surface-sunken text-muted-foreground"
        }
        aria-hidden
      >
        <Icon className="size-5" />
      </span>
      <h3 id={`${testId}-title`} className="text-body font-semibold text-foreground">
        {title}
      </h3>
      <p className="text-body-sm text-muted-foreground">{description}</p>
      {children && <div className="mt-2 flex w-full flex-col items-center gap-2">{children}</div>}
    </section>
  );
}

/**
 * A list (or a reader body) failed to load. `offline`: the device is offline
 * and the store holds nothing for it (owner scope: offline = reading only).
 */
export function ListErrorState({ offline, retrying = false, onRetry }: { offline: boolean; retrying?: boolean; onRetry(): void }) {
  const t = useTranslations("listStates");
  return (
    <div role="alert">
      <StateFrame
        testId="list-error"
        icon={offline ? WifiOff : AlertCircle}
        tone="warn"
        title={offline ? t("offlineTitle") : t("errorTitle")}
        description={offline ? t("offlineDescription") : t("errorDescription")}
      >
        <Button type="button" variant="outline" onClick={onRetry} disabled={retrying} aria-busy={retrying || undefined}>
          <RotateCw className={retrying ? "animate-spin" : undefined} aria-hidden />
          {t("retry")}
        </Button>
      </StateFrame>
    </div>
  );
}

/** A brand-new account: nothing to read until a feed exists. */
export function NoFeedsState({ onAddFeed, onDiscover }: { onAddFeed(): void; onDiscover(): void }) {
  const t = useTranslations("listStates");
  return (
    <StateFrame testId="list-no-feeds" icon={Rss} title={t("noFeedsTitle")} description={t("noFeedsDescription")}>
      <Button type="button" className="w-full max-w-60" onClick={onAddFeed}>
        <Plus aria-hidden />
        {t("addFeed")}
      </Button>
      <Button type="button" variant="outline" className="w-full max-w-60" onClick={onDiscover}>
        <Compass aria-hidden />
        {t("discover")}
      </Button>
      <Button asChild variant="ghost" className="w-full max-w-60">
        <Link href="/manage-feeds?tab=opml">
          <FileUp aria-hidden />
          {t("importOpml")}
        </Link>
      </Button>
    </StateFrame>
  );
}

export type EmptyKind = "later" | "starred" | "label" | "generic";

/** An empty list that is not "caught up": Gemerkt (own copy per view) or a feed with nothing in it. */
export function EmptyListState({ kind }: { kind: EmptyKind }) {
  const t = useTranslations("listStates");
  const map: Record<EmptyKind, [LucideIcon, string, string]> = {
    later: [Bookmark, t("laterEmptyTitle"), t("laterEmptyDescription")],
    starred: [Star, t("starredEmptyTitle"), t("starredEmptyDescription")],
    label: [Tag, t("labelEmptyTitle"), t("labelEmptyDescription")],
    generic: [Inbox, t("emptyTitle"), t("emptyDescription")],
  };
  const [icon, title, description] = map[kind];
  return <StateFrame testId={`list-empty-${kind}`} icon={icon} title={title} description={description} />;
}

/**
 * The rows came from the device store although the browser is online: the
 * server did not answer (5xx, proxy, lie-fi). Says so, offers a retry — the
 * list may be incomplete and must never read as the full list (audit R1).
 */
export function StoredListBanner({ retrying, onRetry }: { retrying: boolean; onRetry(): void }) {
  const t = useTranslations("listStates");
  return (
    <div
      role="status"
      data-testid="list-stored-banner"
      className="flex items-center gap-3 rounded-row border border-warning/30 bg-warning-subtle px-3 py-2 text-body-sm text-foreground"
    >
      <CloudOff className="size-4 shrink-0 text-warning" aria-hidden />
      <span className="min-w-0 flex-1">{t("storedTitle")}</span>
      <Button type="button" variant="outline" size="sm" onClick={onRetry} disabled={retrying} aria-busy={retrying || undefined}>
        <RotateCw className={retrying ? "animate-spin" : undefined} aria-hidden />
        {t("retry")}
      </Button>
    </div>
  );
}

/** End of a store-sourced list: only what is on this device — never "caught up". */
export function StoredListEnd({ full }: { full: boolean }) {
  const t = useTranslations("listStates");
  return (
    <p data-testid="list-stored-end" className="flex items-center justify-center gap-2 px-6 py-8 text-center text-footnote text-muted-foreground">
      <Archive className="size-4 shrink-0" aria-hidden />
      {full ? t("storedEndFull") : t("storedEndSample")}
    </p>
  );
}
