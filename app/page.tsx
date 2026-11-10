import { Suspense } from "react";
import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { BootstrapHydrator } from "@/components/shell/bootstrap-hydrator";
import { ReaderShell } from "@/components/shell/reader-shell";
import { ShellSkeleton } from "@/components/shell/shell-skeleton";
import { UI_COOKIE, parseUiCookie } from "@/features/reader/layout/ui-prefs";
import { readingPreferencesFor } from "@/server/bootstrap";
import { currentSession } from "@/server/session";
import { hasUsers } from "./actions/onboarding";

// Server gate of the reader shell (.pm/spec-shell-design.md §1.1): the session
// is checked here, so the client never shows a "loading session" spinner and
// never branches on it. UI prefs that change first paint come from the
// `ff_ui` cookie. Everything else lives in the URL (nav store) and the query
// cache; in-shell navigation never comes back here (history API, no RSC).
// Cold start (§2.5): the skeleton streams at once, then the shell with its
// data already in the cache (first rows in the HTML, no data requests).

type SearchParams = Promise<Record<string, string | string[] | undefined>>;

function hrefFrom(params: Awaited<SearchParams>): string {
  const sp = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (Array.isArray(value)) value.forEach((v) => sp.append(key, v));
    else if (value !== undefined) sp.append(key, value);
  }
  const qs = sp.toString();
  return qs ? `/?${qs}` : "/";
}

export default async function ReaderPage({ searchParams }: { searchParams: SearchParams }) {
  const session = await currentSession();
  const userId = session?.user?.id;
  if (!userId) {
    // First run (no account yet) → onboarding; otherwise log in.
    redirect((await hasUsers().catch(() => true)) ? "/login" : "/setup");
  }
  const [params, jar, prefs] = await Promise.all([searchParams, cookies(), readingPreferencesFor(userId)]);
  const href = hrefFrom(params);
  const ui = parseUiCookie(jar.get(UI_COOKIE)?.value);
  return (
    <Suspense fallback={<ShellSkeleton href={href} ui={ui} viewMode={prefs.defaultViewMode} />}>
      <BootstrapHydrator userId={userId} href={href}>
        <ReaderShell initialHref={href} initialUi={ui} userId={userId} />
      </BootstrapHydrator>
    </Suspense>
  );
}
