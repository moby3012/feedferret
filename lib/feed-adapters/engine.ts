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

/** Lower-case, no leading "www.", no trailing root dot ("moddb.com." is moddb.com). */
const stripWww = (host: string) => host.toLowerCase().replace(/\.+$/, "").replace(/^www\./, "");
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

/**
 * The page as discovery already parsed it. Detection only reads the DOM
 * (selectors, attribute values) and short, capped strings — never regexes
 * over raw page HTML (ReDoS on attacker-controlled pages).
 */
export type PageSignals = { document: Document; headers?: Headers | null; url: URL };

/** Inline-script text budget for `scriptIncludes` / base `script` patterns. */
export const SCRIPT_TEXT_CAP = 64 * 1024;
const ATTR_CAP = 200;

/** All `<meta name="generator">` values (each capped). */
export function generatorValues(document: Document): string[] {
  const out: string[] = [];
  for (const el of document.querySelectorAll("meta[name]")) {
    if ((el.getAttribute("name") ?? "").trim().toLowerCase() !== "generator") continue;
    const v = (el.getAttribute("content") ?? "").trim().slice(0, ATTR_CAP);
    if (v) out.push(v);
  }
  return out;
}

/** Concatenated inline-script text, capped at SCRIPT_TEXT_CAP. */
function inlineScriptText(document: Document): string {
  let out = "";
  for (const el of document.querySelectorAll("script:not([src])")) {
    out += `${el.textContent ?? ""}\n`;
    if (out.length >= SCRIPT_TEXT_CAP) return out.slice(0, SCRIPT_TEXT_CAP);
  }
  return out;
}

function safeMatches(document: Document, selector: string): boolean {
  try {
    return document.querySelector(selector) !== null;
  } catch {
    return false;
  }
}

export function detectSoftware(page: PageSignals, adapters: SoftwareAdapter[] = SOFTWARE_ADAPTERS): SoftwareAdapter[] {
  const generators = generatorValues(page.document);
  let scripts: string | null = null;
  const scriptText = () => (scripts ??= inlineScriptText(page.document));
  return adapters.filter(({ detect }) => {
    if (detect.generator && generators.some((g) => detect.generator!.test(g))) return true;
    if (detect.headers) {
      for (const [name, re] of Object.entries(detect.headers)) {
        const v = page.headers?.get(name)?.slice(0, ATTR_CAP);
        if (v && re.test(v)) return true;
      }
    }
    if (detect.selectors?.some((sel) => safeMatches(page.document, sel))) return true;
    return detect.scriptIncludes?.some((needle) => scriptText().includes(needle)) ?? false;
  });
}

/** Install path of the software on the page's host ("" = site root, else "/forum"). */
export function resolveBasePath(adapter: SoftwareAdapter, page: PageSignals): string {
  const clean = (p: string) => p.replace(/\/+$/, "");
  const fromValue = (raw: string, stripSuffix?: string): string | null => {
    const value = raw.replace(/\\\//g, "/").trim().slice(0, 500);
    try {
      const u = new URL(value || "/", page.url);
      // Only the page's own origin: a CDN / foreign base URL is ignored.
      if (u.origin !== page.url.origin) return null;
      let path = clean(u.pathname);
      if (stripSuffix && path.toLowerCase().endsWith(stripSuffix.toLowerCase())) path = clean(path.slice(0, -stripSuffix.length));
      return path;
    } catch {
      return null;
    }
  };
  for (const { selector, attr, stripSuffix } of adapter.base?.attrs ?? []) {
    let el: Element | null = null;
    try {
      el = page.document.querySelector(selector);
    } catch {
      el = null;
    }
    const raw = el?.getAttribute(attr);
    if (raw === null || raw === undefined) continue;
    const path = fromValue(raw, stripSuffix);
    if (path !== null) return path;
  }
  if (adapter.base?.script?.length) {
    const text = inlineScriptText(page.document);
    for (const re of adapter.base.script) {
      const raw = re.exec(text)?.[1];
      if (raw === undefined) continue;
      const path = fromValue(raw);
      if (path !== null) return path;
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
