import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { auth } from "@/auth";
import { ReaderShell } from "@/components/shell/reader-shell";
import { UI_COOKIE, parseUiCookie } from "@/features/reader/layout/ui-prefs";
import { hasUsers } from "./actions/onboarding";

// Server gate of the reader shell (.pm/spec-shell-design.md §1.1): the session
// is checked here, so the client never shows a "loading session" spinner and
// never branches on it. UI prefs that change first paint come from the
// `ff_ui` cookie. Everything else lives in the URL (nav store) and the query
// cache; in-shell navigation never comes back here (history API, no RSC).

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
  const session = await auth();
  if (!session?.user?.id) {
    // First run (no account yet) → onboarding; otherwise log in.
    redirect((await hasUsers().catch(() => true)) ? "/login" : "/setup");
  }
  const [params, jar] = await Promise.all([searchParams, cookies()]);
  return <ReaderShell initialHref={hrefFrom(params)} initialUi={parseUiCookie(jar.get(UI_COOKIE)?.value)} />;
}
