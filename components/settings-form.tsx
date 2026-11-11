"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useTranslations } from "next-intl";
import { useRouter } from "next/navigation";
import { ArrowLeft, Bell, ChevronLeft, ChevronRight, Hand, Mail, Palette, Rss, ScrollText, User, type LucideIcon } from "lucide-react";
import { backOrHome } from "@/lib/in-app-back";
import { cn } from "@/lib/utils";
import { AppearanceSettings } from "@/components/settings/sections/appearance";
import { ReadingSettings } from "@/components/settings/sections/reading";
import { GesturesHelpSettings } from "@/components/settings/sections/gestures-help";
import { AccountSettings } from "@/components/settings/sections/account";
import { NotificationSettings } from "@/components/settings/sections/notifications";
import { IntegrationSettings } from "@/components/settings/sections/integrations";
import { NewsletterSettings } from "@/components/settings/sections/newsletter";

// Settings shell (audit-ux-2 A-09 / R9). The section lives in the URL
// (`/settings?tab=reading`): deep-linkable, reload keeps it, Back works.
//   compact (<48rem): `/settings` is a navigation list; a section is a pushed
//     level (in-app back and system Back return to the list).
//   wide: two panes — the list on the left, the section on the right
//     (`/settings` shows Darstellung); switching sections replaces the entry.
// Layout is CSS (`data-section` + media queries), never matchMedia at render.
// Each section is its own component under components/settings/sections/.

export const SETTINGS_SECTIONS = ["appearance", "reading", "gestures", "account", "notifications", "newsletter", "integrations"] as const;
export type SettingsSection = (typeof SETTINGS_SECTIONS)[number];

const SECTION_ICON: Record<SettingsSection, LucideIcon> = {
  appearance: Palette,
  reading: ScrollText,
  gestures: Hand,
  account: User,
  notifications: Bell,
  newsletter: Mail,
  integrations: Rss,
};

const SECTION_BODY: Record<SettingsSection, () => React.ReactNode> = {
  appearance: () => <AppearanceSettings />,
  reading: () => <ReadingSettings />,
  gestures: () => <GesturesHelpSettings />,
  account: () => <AccountSettings />,
  notifications: () => <NotificationSettings />,
  newsletter: () => <NewsletterSettings />,
  integrations: () => <IntegrationSettings />,
};

export function parseSettingsSection(value: string | null | undefined): SettingsSection | null {
  return SETTINGS_SECTIONS.find((s) => s === value) ?? null;
}

const COMPACT_QUERY = "(width < 48rem)";
const isCompact = () => typeof window.matchMedia === "function" && window.matchMedia(COMPACT_QUERY).matches;

// The compact list → section level was pushed in this page view (Back can pop it).
let drilled = false;
let listScrollY = 0;

function setSectionUrl(section: SettingsSection | null, mode: "push" | "replace", hash = "") {
  const url = `${window.location.pathname}${section ? `?tab=${section}` : ""}${hash}`;
  // Native history (no RSC round-trip); Next's router keeps its own state in these entries.
  if (mode === "push") window.history.pushState(null, "", url);
  else window.history.replaceState(window.history.state, "", url);
}

const sectionFromLocation = () => parseSettingsSection(new URLSearchParams(window.location.search).get("tab"));

export function SettingsForm({ initialTab, hiddenSections = [] }: { initialTab?: string; hiddenSections?: readonly SettingsSection[] } = {}) {
  const t = useTranslations();
  const router = useRouter();
  const sections = SETTINGS_SECTIONS.filter((s) => !hiddenSections.includes(s));
  const visibleSection = (s: SettingsSection | null) => (s && !hiddenSections.includes(s) ? s : null);
  const hiddenRef = useRef(hiddenSections);
  hiddenRef.current = hiddenSections;
  // The URL is the source of truth: seeded from the server's searchParams, then
  // kept in sync on our own history writes and on Back / Forward (popstate).
  const [active, setActive] = useState<SettingsSection | null>(() => visibleSection(parseSettingsSection(initialTab)));
  const shown: SettingsSection = active ?? "appearance";
  const detailHeading = useRef<HTMLHeadingElement>(null);
  const focusAfterNav = useRef<"detail" | SettingsSection | null>(null);

  // Old deep link `?tab=reading#gestures` (gesture hint before the Gesten & Hilfe section existed).
  useEffect(() => {
    if (active === "reading" && window.location.hash === "#gestures") {
      setSectionUrl("gestures", "replace", "#gestures");
      setActive("gestures");
    }
  }, [active]);

  // A section anchor (`/settings?tab=gestures#gesture-help`): scroll it into view once painted.
  useEffect(() => {
    const id = window.location.hash.slice(1);
    if (!id) return;
    const frame = window.requestAnimationFrame(() => document.getElementById(id)?.scrollIntoView({ block: "start" }));
    return () => window.cancelAnimationFrame(frame);
  }, [shown]);

  useEffect(() => {
    const onPop = () => {
      const raw = sectionFromLocation();
      const section = raw && !hiddenRef.current.includes(raw) ? raw : null;
      // Forward into a section re-enters the pushed level: in-app back may pop it again.
      drilled = section !== null && isCompact();
      setActive(section);
    };
    window.addEventListener("popstate", onPop);
    return () => window.removeEventListener("popstate", onPop);
  }, []);

  // Focus follows the level change: the section title after drilling in, the list row after coming back.
  useEffect(() => {
    const target = focusAfterNav.current;
    if (!target) return;
    focusAfterNav.current = null;
    if (target === "detail") {
      window.scrollTo({ top: 0 });
      detailHeading.current?.focus({ preventScroll: true });
    } else {
      window.scrollTo({ top: listScrollY });
      document.querySelector<HTMLElement>(`[data-settings-nav="${target}"]`)?.focus({ preventScroll: true });
    }
  }, [active]);

  const select = useCallback(
    (section: SettingsSection) => {
      if (section === active) return;
      if (isCompact()) {
        listScrollY = window.scrollY;
        drilled = true;
        focusAfterNav.current = "detail";
        setSectionUrl(section, "push");
      } else {
        // Two panes: a section switch is not a level (Back leaves settings, like a tab switch).
        setSectionUrl(section, "replace");
      }
      setActive(section);
    },
    [active],
  );

  const backToList = useCallback(() => {
    focusAfterNav.current = active;
    if (drilled) {
      drilled = false;
      window.history.back();
    } else {
      setSectionUrl(null, "replace");
      setActive(null);
    }
  }, [active]);

  const label = (s: SettingsSection) => t(`settings.tabs.${s}`);

  return (
    <main
      className="ff-settings min-h-dvh app-chrome text-foreground overflow-x-hidden pt-(--safe-t) ps-(--safe-l) pe-(--safe-r)"
      data-section={active ? "1" : "0"}
      data-testid="settings"
    >
      <div className="mx-auto flex min-h-dvh w-full max-w-6xl flex-col px-4 py-6 pb-[max(1.5rem,var(--safe-b))] sm:px-6 lg:px-8">
        <header className="ff-settings-root-header mb-6 flex items-center gap-3">
          <button
            type="button"
            onClick={() => backOrHome(router)}
            className="hit-slop inline-flex size-11 shrink-0 items-center justify-center rounded-control text-muted-foreground hover:bg-surface-sunken active:bg-surface-sunken"
            aria-label={t("settings.back")}
          >
            <ArrowLeft className="size-5 rtl:-scale-x-100" aria-hidden />
          </button>
          <h1 className="text-headline">{t("settings.title")}</h1>
        </header>

        <div className="ff-settings-panes">
          <nav className="ff-settings-nav" aria-label={t("settings.sectionsNav")}>
            <ul className="ff-settings-nav-list">
              {sections.map((s) => {
                const Icon = SECTION_ICON[s];
                const current = s === shown;
                return (
                  <li key={s}>
                    <a
                      href={`/settings?tab=${s}`}
                      className="ff-settings-nav-item"
                      data-settings-nav={s}
                      data-current={current ? "" : undefined}
                      aria-current={current ? "page" : undefined}
                      onClick={(e) => {
                        if (e.metaKey || e.ctrlKey || e.shiftKey || e.altKey || e.button !== 0) return;
                        e.preventDefault();
                        select(s);
                      }}
                    >
                      <span className="ui-brand-icon inline-flex size-8 shrink-0 items-center justify-center rounded-control">
                        <Icon className="size-4" aria-hidden />
                      </span>
                      <span className="min-w-0 flex-1 truncate">{label(s)}</span>
                      <ChevronRight className="ff-settings-nav-chevron size-4 shrink-0 text-muted-foreground rtl:-scale-x-100" aria-hidden />
                    </a>
                  </li>
                );
              })}
            </ul>
          </nav>

          <section className="ff-settings-detail min-w-0" aria-labelledby="settings-section-title" data-testid={`settings-section-${shown}`}>
            <div className="ff-settings-detail-header mb-5 flex items-center gap-2">
              <button
                type="button"
                className="ff-settings-detail-back hit-slop inline-flex h-11 shrink-0 items-center gap-1 rounded-control pe-2 text-body text-link active:bg-surface-sunken"
                onClick={backToList}
              >
                <ChevronLeft className="size-5 rtl:-scale-x-100" aria-hidden />
                {t("settings.backToSettings")}
              </button>
            </div>
            <h2 id="settings-section-title" ref={detailHeading} tabIndex={-1} className={cn("mb-5 text-headline outline-none")}>
              {label(shown)}
            </h2>
            <div key={shown} className="animate-filter-swap grid gap-5">
              {SECTION_BODY[shown]()}
            </div>
          </section>
        </div>
      </div>
    </main>
  );
}
