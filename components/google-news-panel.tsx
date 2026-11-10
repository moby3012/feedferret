"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { useFormatter, useLocale, useTranslations } from "next-intl";
import { Loader2, Newspaper } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import {
  useAddGoogleNewsFeed,
  useGoogleNewsFeedSearch,
  usePreviewGoogleNewsFeed,
  useUpdateGoogleNewsFeedQuery,
} from "@/hooks/use-rss-data";
import {
  GOOGLE_NEWS_EDITIONS,
  GOOGLE_NEWS_MAX_QUERY,
  GOOGLE_NEWS_WINDOWS,
  googleNewsEdition,
  normalizeGoogleNewsQuery,
  type GoogleNewsWindow,
} from "@/lib/google-news-url";

type Search = { query: string; edition: string; when: GoogleNewsWindow };
type PreviewState =
  | { status: "idle" }
  | { status: "loading" }
  | { status: "error"; code: string }
  | {
      status: "ready";
      name: string;
      itemCount: number;
      items: { title: string; source: string | null; publishedAt: string | null }[];
    };

const PREVIEW_DEBOUNCE_MS = 700;
const MIN_QUERY = 2;

/** "Deutschland · Deutsch" for an edition, in the UI language. */
function useEditionLabel() {
  const locale = useLocale();
  return useMemo(() => {
    let regions: Intl.DisplayNames | null = null;
    let languages: Intl.DisplayNames | null = null;
    try {
      regions = new Intl.DisplayNames([locale], { type: "region" });
      languages = new Intl.DisplayNames([locale], { type: "language" });
    } catch {
      /* very old engines: fall back to the code */
    }
    return (edition: string) => {
      const [lang, region] = edition.split("-");
      if (!regions || !languages) return edition;
      return `${regions.of(region) ?? region} · ${languages.of(lang) ?? lang}`;
    };
  }, [locale]);
}

/** "DE · Deutsch": region code + language name, fits a half-width trigger. */
function useShortEditionLabel() {
  const locale = useLocale();
  return useMemo(() => {
    let languages: Intl.DisplayNames | null = null;
    try {
      languages = new Intl.DisplayNames([locale], { type: "language" });
    } catch {
      /* fall back to the code */
    }
    return (edition: string) => {
      const [lang, region] = edition.split("-");
      return `${region} · ${languages?.of(lang) ?? lang}`;
    };
  }, [locale]);
}

/** Query + edition + time window fields, shared by "add" and "edit". */
function SearchFields({ value, onChange, idPrefix }: { value: Search; onChange: (next: Search) => void; idPrefix: string }) {
  const t = useTranslations("googleNews");
  const editionLabel = useEditionLabel();
  const shortEditionLabel = useShortEditionLabel();
  const editions = useMemo(() => {
    const list: string[] = [...GOOGLE_NEWS_EDITIONS];
    if (value.edition && !list.includes(value.edition)) list.unshift(value.edition);
    return list;
  }, [value.edition]);

  return (
    <div className="space-y-2.5">
      <div className="space-y-1">
        <Label htmlFor={`${idPrefix}-query`} className="text-xs font-medium">{t("queryLabel")}</Label>
        <Input
          id={`${idPrefix}-query`}
          placeholder={t("queryPlaceholder")}
          value={value.query}
          maxLength={GOOGLE_NEWS_MAX_QUERY}
          onChange={(e) => onChange({ ...value, query: e.target.value })}
          className="h-9 text-sm"
          enterKeyHint="search"
          autoComplete="off"
        />
        <p className="text-caption text-muted-foreground leading-relaxed">{t("operatorsHint")}</p>
      </div>
      <div className="grid grid-cols-2 gap-2">
        <div className="min-w-0 space-y-1">
          <Label htmlFor={`${idPrefix}-edition`} className="text-xs font-medium">{t("editionLabel")}</Label>
          <Select value={value.edition} onValueChange={(edition) => onChange({ ...value, edition })}>
            <SelectTrigger id={`${idPrefix}-edition`} className="h-9 w-full text-sm" aria-label={t("editionLabel")}>
              {/* Compact in the half-width trigger ("DE · Deutsch"); full names in the list. */}
              <SelectValue>{shortEditionLabel(value.edition)}</SelectValue>
            </SelectTrigger>
            <SelectContent>
              {editions.map((edition) => (
                <SelectItem key={edition} value={edition}>{editionLabel(edition)}</SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <div className="min-w-0 space-y-1">
          <Label htmlFor={`${idPrefix}-when`} className="text-xs font-medium">{t("windowLabel")}</Label>
          <Select value={value.when || "any"} onValueChange={(when) => onChange({ ...value, when: (when === "any" ? "" : when) as GoogleNewsWindow })}>
            <SelectTrigger id={`${idPrefix}-when`} className="h-9 w-full text-sm" aria-label={t("windowLabel")}>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {GOOGLE_NEWS_WINDOWS.map((when) => (
                <SelectItem key={when || "any"} value={when || "any"}>{t(`windows.${when || "any"}`)}</SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
      </div>
    </div>
  );
}

/** Debounced live preview of the search (first few results). */
function useLivePreview(search: Search, enabled: boolean): PreviewState {
  const preview = usePreviewGoogleNewsFeed();
  const [state, setState] = useState<PreviewState>({ status: "idle" });
  const seq = useRef(0);
  const query = normalizeGoogleNewsQuery(search.query);
  const mutate = preview.mutateAsync;

  useEffect(() => {
    const id = ++seq.current;
    if (!enabled || query.length < MIN_QUERY) {
      setState({ status: "idle" });
      return;
    }
    setState({ status: "loading" });
    const timer = setTimeout(() => {
      mutate({ query, edition: search.edition, when: search.when })
        .then((result) => {
          if (id !== seq.current) return;
          if (!result.success) setState({ status: "error", code: result.error });
          else setState({ status: "ready", name: result.name, itemCount: result.itemCount, items: result.items });
        })
        .catch(() => {
          if (id === seq.current) setState({ status: "error", code: "fetchFailed" });
        });
    }, PREVIEW_DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [enabled, query, search.edition, search.when, mutate]);

  return state;
}

function PreviewCard({ state, children }: { state: PreviewState; children?: React.ReactNode }) {
  const t = useTranslations("googleNews");
  const format = useFormatter();
  if (state.status === "idle") return null;
  if (state.status === "loading") {
    return (
      <div className="flex items-center gap-2 rounded-xl bg-muted/60 px-3 py-2.5 text-xs text-muted-foreground" role="status">
        <Loader2 className="size-3.5 animate-spin" />
        {t("previewLoading")}
      </div>
    );
  }
  if (state.status === "error") {
    return (
      <div className="rounded-xl border border-warning/20 bg-warning/10 px-3 py-2 text-xs text-warning" role="alert">
        {t.has(`errors.${state.code}`) ? t(`errors.${state.code}`) : t("errors.fetchFailed")}
      </div>
    );
  }
  return (
    <div className="ui-control-surface space-y-2 rounded-xl border px-3 py-2.5" data-testid="google-news-preview">
      <p className="flex items-center gap-1.5 text-xs font-medium text-foreground">
        <Newspaper className="size-3.5 shrink-0 text-muted-foreground" />
        <span className="truncate">{state.name}</span>
      </p>
      <p className="text-caption text-muted-foreground">{t("itemsFound", { count: state.itemCount })}</p>
      {state.itemCount === 0 && <p className="text-xs text-muted-foreground">{t("noResultsHint")}</p>}
      <ul className="space-y-1.5">
        {state.items.map((item, i) => (
          <li key={i} className="min-w-0">
            <p className="line-clamp-2 text-xs text-foreground">{item.title}</p>
            <p className="truncate text-caption text-muted-foreground">
              {[item.source, item.publishedAt ? format.relativeTime(new Date(item.publishedAt)) : null].filter(Boolean).join(" · ")}
            </p>
          </li>
        ))}
      </ul>
      {children}
    </div>
  );
}

interface GoogleNewsPanelProps {
  categoryId?: string;
  initialQuery?: string;
  onCreated: (feed: { name: string }) => void;
}

/** Add-feed dialog → More sources → Google News: keyword search as a feed. */
export function GoogleNewsPanel({ categoryId, initialQuery, onCreated }: GoogleNewsPanelProps) {
  const t = useTranslations("googleNews");
  const locale = useLocale();
  const [search, setSearch] = useState<Search>(() => ({ query: initialQuery ?? "", edition: googleNewsEdition(locale), when: "" }));
  const [addError, setAddError] = useState<string | null>(null);
  const add = useAddGoogleNewsFeed();
  const preview = useLivePreview(search, true);

  useEffect(() => {
    if (initialQuery) setSearch((s) => ({ ...s, query: initialQuery }));
  }, [initialQuery]);

  const handleAdd = async () => {
    setAddError(null);
    try {
      const result = await add.mutateAsync({ ...search, categoryId: categoryId && categoryId !== "none" ? categoryId : undefined });
      if (!result.success) {
        setAddError(t.has(`errors.${result.error}`) ? t(`errors.${result.error}`) : t("errors.fetchFailed"));
        return;
      }
      onCreated({ name: result.feed.name });
    } catch {
      setAddError(t("errors.fetchFailed"));
    }
  };

  return (
    <div className="space-y-3">
      <p className="text-xs text-muted-foreground leading-relaxed">{t("intro")}</p>
      <SearchFields value={search} onChange={(next) => { setSearch(next); setAddError(null); }} idPrefix="gn-add" />
      <PreviewCard state={preview}>
        <Button size="sm" className="w-full" disabled={add.isPending} onClick={handleAdd}>
          {add.isPending && <Loader2 className="me-1.5 size-4 animate-spin" />}
          {t("subscribe")}
        </Button>
      </PreviewCard>
      {addError && (
        <div className="rounded-xl border border-warning/20 bg-warning/10 px-3 py-2 text-xs text-warning" role="alert">
          {addError}
        </div>
      )}
    </div>
  );
}

/** Feed settings: edit the search of an existing Google News feed. */
export function GoogleNewsQueryEditor({ feedId, onSaved }: { feedId: string; onSaved?: () => void }) {
  const t = useTranslations("googleNews");
  const { data: stored, isLoading } = useGoogleNewsFeedSearch(feedId, true);
  const [search, setSearch] = useState<Search | null>(null);
  const [message, setMessage] = useState<{ tone: "ok" | "error"; text: string } | null>(null);
  const update = useUpdateGoogleNewsFeedQuery();

  useEffect(() => {
    if (stored) setSearch({ query: stored.query, edition: stored.edition, when: stored.when });
  }, [stored]);

  const dirty =
    !!search && !!stored && (normalizeGoogleNewsQuery(search.query) !== stored.query || search.edition !== stored.edition || search.when !== stored.when);
  const preview = useLivePreview(search ?? { query: "", edition: "de-DE", when: "" }, dirty);

  if (isLoading || !stored || !search) return null;

  const handleSave = async () => {
    setMessage(null);
    try {
      const result = await update.mutateAsync({ feedId, search });
      if (!result.success) {
        setMessage({ tone: "error", text: t.has(`errors.${result.error}`) ? t(`errors.${result.error}`) : t("errors.fetchFailed") });
        return;
      }
      setMessage({ tone: "ok", text: t("saved") });
      onSaved?.();
    } catch {
      setMessage({ tone: "error", text: t("errors.fetchFailed") });
    }
  };

  return (
    <section className="space-y-3 rounded-2xl border border-border/70 p-4" aria-labelledby="gn-edit-title">
      <div>
        <h3 id="gn-edit-title" className="text-sm font-semibold">{t("editTitle")}</h3>
        <p className="mt-0.5 text-xs text-muted-foreground">{t("editDescription")}</p>
      </div>
      <SearchFields value={search} onChange={(next) => { setSearch(next); setMessage(null); }} idPrefix="gn-edit" />
      {dirty && <PreviewCard state={preview} />}
      <p className="text-caption text-muted-foreground">{t("editApplyHint")}</p>
      <div className="flex items-center justify-end gap-2">
        {message && (
          <p className={message.tone === "ok" ? "me-auto text-xs text-success" : "me-auto text-xs text-warning"} role="status">
            {message.text}
          </p>
        )}
        <Button size="sm" className="rounded-xl" disabled={!dirty || normalizeGoogleNewsQuery(search.query).length === 0 || update.isPending} onClick={handleSave}>
          {update.isPending && <Loader2 className="me-1.5 size-4 animate-spin" />}
          {t("saveSearch")}
        </Button>
      </div>
    </section>
  );
}
