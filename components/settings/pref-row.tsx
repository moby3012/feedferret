"use client";

import { useTranslations } from "next-intl";
import { Laptop, Moon, Sun } from "lucide-react";

export function makeThemeOptions(t: ReturnType<typeof useTranslations>) {
  return [
    { id: "light", label: t("settings.themeOptions.light"), icon: Sun },
    { id: "dark", label: t("settings.themeOptions.dark"), icon: Moon },
    { id: "system", label: t("settings.themeOptions.system"), icon: Laptop },
  ];
}

export function normalizeDefaultViewMode(value?: string | null) {
  if (value === "minimal" || value === "magazine" || value === "list") {
    return value;
  }
  if (value === "grid") {
    return "magazine";
  }
  return "list";
}

export function PrefRow({
  icon: Icon,
  title,
  description,
  children,
}: {
  icon: any;
  title: string;
  description: string;
  children: React.ReactNode;
}) {
  return (
    <section className="rounded-panel border border-border/65 bg-card/85 p-5 sm:p-6">
      <div className="flex flex-col gap-6 sm:flex-row sm:items-center sm:justify-between">
        <div className="flex items-start gap-4">
          <div className="ui-brand-icon flex h-12 w-12 shrink-0 items-center justify-center rounded-panel">
            <Icon className="h-5 w-5" />
          </div>
          <div>
            <h2 className="text-title-sm font-semibold tracking-title">{title}</h2>
            <p className="mt-1 max-w-xl text-body-sm leading-6 text-muted-foreground">{description}</p>
          </div>
        </div>
        <div className="w-full shrink-0 sm:w-auto">{children}</div>
      </div>
    </section>
  );
}

export function getCommonTimezones(): string[] {
  const common = [
    "UTC",
    "Europe/London",
    "Europe/Berlin",
    "Europe/Paris",
    "Europe/Madrid",
    "Europe/Rome",
    "Europe/Amsterdam",
    "Europe/Stockholm",
    "Europe/Warsaw",
    "Europe/Moscow",
    "Europe/Istanbul",
    "America/New_York",
    "America/Chicago",
    "America/Denver",
    "America/Los_Angeles",
    "America/Toronto",
    "America/Sao_Paulo",
    "America/Mexico_City",
    "Asia/Tokyo",
    "Asia/Shanghai",
    "Asia/Singapore",
    "Asia/Hong_Kong",
    "Asia/Seoul",
    "Asia/Kolkata",
    "Asia/Dubai",
    "Australia/Sydney",
    "Australia/Melbourne",
    "Pacific/Auckland",
    "Africa/Johannesburg",
    "Africa/Cairo",
  ];
  try {
    const browserTz = Intl.DateTimeFormat().resolvedOptions().timeZone;
    if (browserTz && !common.includes(browserTz)) common.unshift(browserTz);
  } catch {}
  return common;
}
