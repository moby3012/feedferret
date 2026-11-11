// Pure evaluation of the adapter registry (no I/O): URL → platform feed
// candidates, fetched page → detected software → feed candidates. Callers
// (lib/feed-discovery.ts) verify every candidate before offering it.

import type { FeedKind } from "../smart-url-resolver";
import {
  PLATFORM_ADAPTERS,
  RSSHUB_ONLY_PLATFORMS,
  SOFTWARE_ADAPTERS,
  type AdapterFamily,
  type AdapterRoute,
  type FeedTemplate,
  type PlatformAdapter,
  type SoftwareAdapter,
} from "./registry";

export type AdapterCandidate = {
  url: string;
  title: string;
  kind: FeedKind;
  adapterId: string;
  /** For the UI: "<name>-Feed" / "<name>-Forum" / … */
  via: { family: AdapterFamily; name: string };
  /** Route-specific (what the user pointed at) vs. site-wide feed. */
  scope: "route" | "site";
};

/** Cap per adapter: every candidate costs one verification request. */
const MAX_PER_ADAPTER = 4;
const SAFE_TOKEN = /^[\w.~-]{1,100}$/;

const stripWww = (host: string) => host.toLowerCase().replace(/^www\./, "");
const hostMatches = (host: string, domains: string[]) => domains.some((d) => host === d || host.endsWith(`.${d}`));

type ExpandCtx = { origin: string; base: string; domain: string; groups: string[]; query: URLSearchParams };

/** Fills a template; null when a placeholder has no (safe) value. */
export function expandTemplate(template: string, ctx: ExpandCtx): string | null {
  let failed = false;
  const out = template.replace(/\{(origin|base|domain|\$\d|\?[\w-]+)\}/g, (_, key: string) => {
    if (key === "origin") return ctx.origin;
    if (key === "base") return ctx.base;
    if (key === "domain") return ctx.domain;
    if (key.startsWith("$")) {
      const v = ctx.groups[Number(key.slice(1))];
      if (v === undefined || v === "") failed = true;
      return v ?? "";
    }
    const v = ctx.query.get(key.slice(1));
    if (!v || !SAFE_TOKEN.test(v)) failed = true;
    return v ? encodeURIComponent(v) : "";
  });
  if (failed) return null;
  try {
    const url = new URL(out);
    return /^https?:$/.test(url.protocol) ? url.toString() : null;
  } catch {
    return null;
  }
}

function expandFeeds(
  templates: FeedTemplate[],
  ctx: ExpandCtx,
  adapter: { id: string; name: string; family: AdapterFamily },
  scope: AdapterCandidate["scope"],
): AdapterCandidate[] {
  const out: AdapterCandidate[] = [];
  for (const t of templates) {
    const url = expandTemplate(t.url, ctx);
    if (!url) continue;
    const label = t.label.replace(/\{\$(\d)\}/g, (_, i: string) => safeDecode(ctx.groups[Number(i)] ?? ""));
    out.push({
      url,
      title: `${adapter.name} · ${label}`,
      kind: t.kind,
      adapterId: adapter.id,
      via: { family: adapter.family, name: adapter.name },
      scope,
    });
  }
  return out;
}

function safeDecode(v: string): string {
  try {
    return decodeURIComponent(v);
  } catch {
    return v;
  }
}

function firstRoute(routes: AdapterRoute[], path: string): { route: AdapterRoute; groups: string[] } | null {
  for (const route of routes) {
    const m = route.pattern.exec(path);
    if (m) return { route, groups: [...m] };
  }
  return null;
}

function dedupe(list: AdapterCandidate[]): AdapterCandidate[] {
  const seen = new Set<string>();
  return list.filter((c) => (seen.has(c.url) ? false : (seen.add(c.url), true)));
}

/* -------------------------------------------------------------------------- */
/* (a) URL patterns                                                            */
/* -------------------------------------------------------------------------- */

export function platformAdapterFor(url: URL, adapters: PlatformAdapter[] = PLATFORM_ADAPTERS): PlatformAdapter | null {
  const host = stripWww(url.hostname);
  return adapters.find((a) => hostMatches(host, a.hosts)) ?? null;
}

/** Feed candidates from the URL alone (first matching route of the platform). */
export function matchPlatformAdapters(url: URL, adapters: PlatformAdapter[] = PLATFORM_ADAPTERS): AdapterCandidate[] {
  const adapter = platformAdapterFor(url, adapters);
  if (!adapter) return [];
  const host = stripWww(url.hostname);
  const domain = adapter.hosts.find((d) => host === d || host.endsWith(`.${d}`)) ?? host;
  const path = url.pathname.replace(/\/{2,}/g, "/");
  const hit = firstRoute(adapter.routes, path);
  if (!hit) return [];
  const ctx: ExpandCtx = { origin: url.origin, base: url.origin, domain, groups: hit.groups, query: url.searchParams };
  return dedupe(expandFeeds(hit.route.feeds, ctx, adapter, "route")).slice(0, MAX_PER_ADAPTER);
}

/* -------------------------------------------------------------------------- */
/* (b) Software detection                                                      */
/* -------------------------------------------------------------------------- */

export type PageSignals = { html: string; headers?: Headers | null; url: URL };

/** All `<meta name="generator">` values in the page head. */
export function generatorValues(html: string): string[] {
  const out: string[] = [];
  for (const tag of html.match(/<meta\b[^>]*>/gi) ?? []) {
    if (!/\bname\s*=\s*["']?generator["']?/i.test(tag)) continue;
    const content = /\bcontent\s*=\s*(?:"([^"]*)"|'([^']*)')/i.exec(tag);
    const v = (content?.[1] ?? content?.[2] ?? "").trim();
    if (v) out.push(v);
  }
  return out;
}

export function detectSoftware(page: PageSignals, adapters: SoftwareAdapter[] = SOFTWARE_ADAPTERS): SoftwareAdapter[] {
  const generators = generatorValues(page.html);
  return adapters.filter(({ detect }) => {
    if (detect.generator && generators.some((g) => detect.generator!.test(g))) return true;
    if (detect.headers) {
      for (const [name, re] of Object.entries(detect.headers)) {
        const v = page.headers?.get(name);
        if (v && re.test(v)) return true;
      }
    }
    return detect.html?.some((re) => re.test(page.html)) ?? false;
  });
}

/** Install path of the software on the page's host ("" = site root, else "/forum"). */
export function resolveBasePath(adapter: SoftwareAdapter, page: PageSignals): string {
  const clean = (p: string) => p.replace(/\/+$/, "");
  for (const re of adapter.base?.html ?? []) {
    const raw = re.exec(page.html)?.[1];
    if (raw === undefined) continue;
    const value = raw.replace(/\\\//g, "/").trim();
    try {
      const u = new URL(value || "/", page.url);
      // Only the page's own origin: a CDN / foreign base URL is ignored.
      if (u.origin === page.url.origin) return clean(u.pathname);
    } catch {
      // try the next signal
    }
  }
  const path = page.url.pathname.replace(/\/{2,}/g, "/");
  const before = adapter.base?.before;
  if (before?.length) {
    const segs = path.split("/");
    const idx = segs.findIndex((s, i) => i > 0 && before.includes(s.toLowerCase()));
    if (idx > 0) return clean(segs.slice(0, idx).join("/"));
  }
  // Forums are often installed in a sub-folder: the page's directory (a
  // script page such as viewforum.php lives in the install directory).
  // Everything else defaults to the site root.
  if (adapter.base?.fallback === "dir") return clean(path.replace(/\/[^/]*\.(?:php|aspx?|html?|cgi)$/i, "/"));
  return "";
}

/** Candidates for one detected software on the given page (route-specific first, then site-wide). */
export function softwareCandidates(adapter: SoftwareAdapter, page: PageSignals): AdapterCandidate[] {
  const basePath = resolveBasePath(adapter, page);
  const path = page.url.pathname.replace(/\/{2,}/g, "/");
  const rel = basePath && path.toLowerCase().startsWith(basePath.toLowerCase()) ? path.slice(basePath.length) || "/" : path;
  const ctx: ExpandCtx = {
    origin: page.url.origin,
    base: `${page.url.origin}${basePath}`,
    domain: stripWww(page.url.hostname),
    groups: [],
    query: page.url.searchParams,
  };
  const hit = firstRoute(adapter.routes, rel.startsWith("/") ? rel : `/${rel}`);
  const route = hit ? expandFeeds(hit.route.feeds, { ...ctx, groups: hit.groups }, adapter, "route") : [];
  const site = expandFeeds(adapter.site, ctx, adapter, "site");
  return dedupe([...route, ...site]).slice(0, MAX_PER_ADAPTER);
}

/** Every detected software's candidates, at most `limit` overall. */
export function detectSoftwareFeeds(page: PageSignals, limit = 8): AdapterCandidate[] {
  return dedupe(detectSoftware(page).flatMap((a) => softwareCandidates(a, page))).slice(0, limit);
}

/* -------------------------------------------------------------------------- */
/* (d) RSSHub-only platforms                                                   */
/* -------------------------------------------------------------------------- */

/** Display name of a platform that only works through RSSHub, or null. */
export function rsshubOnlyPlatform(url: URL): string | null {
  const host = stripWww(url.hostname);
  return RSSHUB_ONLY_PLATFORMS.find((p) => hostMatches(host, p.hosts))?.name ?? null;
}
