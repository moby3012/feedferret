/**
 * Shared OPML import core.
 *
 * Every entry point that turns an OPML document into subscriptions goes through
 * this module so they all map the same fields and report the same things:
 *
 *   - settings UI (`importOpml` server action) and the FreshRSS migration flow
 *   - REST v1  `POST /api/v1/opml`
 *   - MCP      `feedferret.import_opml`
 *   - remote dynamic-OPML categories (`lib/dynamic-opml.ts`, `trust: "remote"`)
 *
 * Phase 1 (`planOpmlImport`) is pure: it maps outlines to FeedFerret fields and
 * collects an `ImportIssue` for everything that is adapted, preserved or not
 * supported, so nothing is dropped silently. Phase 2 (`applyOpmlImportPlan`)
 * writes user-scoped rows, or only counts when `dryRun` is set.
 */

import { db } from "@/lib/db";
import {
  httpOptionsFromOutline,
  MAX_UPDATE_MINUTES,
  MIN_UPDATE_MINUTES,
  parseOpml,
  scraperConfigFromOutline,
  ttlToMinutes,
  unknownExtensions,
  type OpmlOutline,
} from "@/lib/opml";
import { BLOCKED_REQUEST_HEADERS, EXTRACTION_SOURCE_TYPES, JSON_ATTRS, MAX_FEED_REDIRECTS, XPATH_ATTRS, normalizeSourceType, stringifyNonEmpty, type FeedExtractionConfig } from "@/lib/feed-extraction";
import { canonicalApiSourceUrl } from "@/lib/feed-adapters/api-source-url";
import { MAX_SEARCH_QUERY, validateFeedUrl, validateOpml } from "@/lib/validation";
import { translateFreshRssReadFilters } from "./frss-filters";
import { assertSafeHttpOptionsProxy, proxyFromHttpOptions } from "@/lib/ssrf";
import { connectorFeedUrlErrorWith, getConnectorSecretRules, stripConnectorSecretsWith } from "@/lib/connector-secrets";
import { withImportSlot } from "./import-slots";

/** `local`: a file the signed-in user uploaded. `remote`: fetched from a third-party URL (dynamic OPML). */
export type ImportTrust = "local" | "remote";

export interface ImportIssue {
  /** unsupported: not imported; adapted: imported with a different semantic; preserved: kept but inactive. */
  kind: "unsupported" | "adapted" | "preserved";
  code: string;
  /** Feed or category the issue belongs to. */
  subject: string;
  attribute?: string;
  detail?: string;
}

export interface FeedWriteData {
  name: string;
  sourceType: string;
  htmlUrl: string | null;
  description: string | null;
  priority: string;
  /** True when the outline carried a valid priority (otherwise `priority` is just the default). */
  priorityGiven?: boolean;
  unicityCriteria: string;
  unicityCriteriaForced: boolean;
  scraperConfig: string | null;
  httpOptions: string | null;
  // Written only when the OPML carried the attribute (never wipes local edits).
  filtersActionRead?: string | null;
  fullTextSelector?: string;
  fullTextConditions?: string;
  fullTextRemoveSelectors?: string;
  enableSelectorMode?: boolean;
  /** FreshRSS priorities below "main" keep the feed out of the main stream ("All feeds"). */
  hideFromAllFeeds?: boolean;
  updateFrequency?: number;
  mute?: boolean;
  customUserAgent?: string;
}

export interface PlannedFeed {
  url: string;
  name: string;
  data: FeedWriteData;
  /** FeedFerret query for a feed-scoped mark-read rule (translated FreshRSS read filters). */
  ruleQuery: string | null;
}

export interface PlannedCategory {
  name: string;
  opmlUrl: string | null;
  children: PlannedCategory[];
  feeds: PlannedFeed[];
}

export interface OpmlImportPlan {
  /** Who produced the outlines; remote plans never touch HTTP options of existing feeds. */
  trust?: ImportTrust;
  categories: PlannedCategory[];
  /** Feeds that sit outside any category. */
  feeds: PlannedFeed[];
  issues: ImportIssue[];
  errors: string[];
}

export interface OpmlImportReport {
  dryRun: boolean;
  feedsAdded: number;
  feedsUpdated: number;
  categoriesAdded: number;
  categoriesUpdated: number;
  rulesCreated: number;
  rulesUpdated: number;
  errors: string[];
  issues: ImportIssue[];
}

const PRIORITIES = new Set(["important", "main", "category", "feed", "hidden"]);
let knownTypes: Set<string> | null = null;
const isKnownType = (type: string) => {
  knownTypes ??= new Set([...EXTRACTION_SOURCE_TYPES].map((known) => known.toLowerCase()).concat(["atom", "feed"]));
  return knownTypes.has(type.toLowerCase());
};

// cURL options that execute on the FeedFerret host or carry secrets/network
// targets. They are accepted from the user's own file but never from a remote
// OPML that a third party can change at any time.
const REMOTE_BLOCKED_HTTP = [
  "CURLOPT_COOKIE",
  "CURLOPT_HTTPHEADER",
  "CURLOPT_POST",
  "CURLOPT_POSTFIELDS",
  "CURLOPT_PROXY",
  "CURLOPT_PROXYTYPE",
  "CURLOPT_USERAGENT",
  "CURLOPT_FOLLOWLOCATION",
  "CURLOPT_MAXREDIRS",
] as const;

// Selector / XPath / JSON-path expressions run on every fetch. They are evaluated in
// the HTML worker pool under a time limit (lib/html-worker), but a cheap expression
// can still burn a full task timeout per sync on a crafted page (`:has(* * * *)`,
// `//*[contains(., …)]`). A third party who controls a remote (dynamic) OPML must not
// be able to plant them in another user's feeds on a shared instance.
let remoteBlockedExpressions: string[] | null = null;
const getRemoteBlockedExpressions = () =>
  (remoteBlockedExpressions ??= [
    "cssFullContent", "cssContentFilter", "cssFullContentFilter", "cssFullContentConditions",
    "xPathToJson", ...XPATH_ATTRS, ...JSON_ATTRS,
  ]);

// FreshRSS' importer check plus digits: its own `sha1:*` values need them (upstream
// `^[a-z:_-]{2,64}$` silently drops every `sha1:` criterion). `link:title` also passes.
const UNICITY_PATTERN = /^[a-z0-9:_-]{2,64}$/;

/** Per attribute: one selector / XPath / JSON path / header list / proxy URL. */
export const MAX_EXPRESSION_LENGTH = 2_000;
/** Per attribute: newline-separated search expressions (read filters, full-text conditions). */
export const MAX_FILTER_LIST_LENGTH = 10_000;

function emptyReport(dryRun: boolean): OpmlImportReport {
  return {
    dryRun,
    feedsAdded: 0,
    feedsUpdated: 0,
    categoriesAdded: 0,
    categoriesUpdated: 0,
    rulesCreated: 0,
    rulesUpdated: 0,
    errors: [],
    issues: [],
  };
}

// ── Phase 1: pure mapping ────────────────────────────────────────────────────

export function mapOutlineToFeed(
  outline: OpmlOutline,
  trust: ImportTrust,
  issues: ImportIssue[],
): PlannedFeed | null {
  const subject = outline.text || outline.xmlUrl || "feed";
  const urlError = outline.xmlUrl ? validateFeedUrl(outline.xmlUrl) : "Feed outline has no xmlUrl";
  if (urlError || !outline.xmlUrl) {
    issues.push({ kind: "unsupported", code: "feed-url-invalid", subject, attribute: "xmlUrl", detail: urlError ?? "missing" });
    return null;
  }
  const feedUrl = canonicalApiSourceUrl(outline.xmlUrl) ?? outline.xmlUrl;

  const issue = (kind: ImportIssue["kind"], code: string, attribute?: string, detail?: string) =>
    issues.push({ kind, code, subject, attribute, detail });
  // Oversized selectors / XPath / search expressions are refused at the door: they only
  // make the worker's per-task time limit (lib/html-worker) the common case.
  const extensions: Record<string, string> = {};
  for (const [name, value] of Object.entries(outline.extensions ?? {})) {
    const limit = name === "filtersActionRead" || name === "cssFullContentConditions" ? MAX_FILTER_LIST_LENGTH : MAX_EXPRESSION_LENGTH;
    if (value.length > limit) {
      issue("unsupported", "expression-too-long", name, `${value.length} characters (max ${limit}) — not imported`);
      continue;
    }
    extensions[name] = value;
  }
  if (trust === "remote") {
    const dropped = getRemoteBlockedExpressions().filter((name) => extensions[name] !== undefined);
    for (const name of dropped) delete extensions[name];
    if (dropped.length) issue("unsupported", "expression-remote-dropped", dropped.join(", "), "selectors and XPath/JSON expressions are not accepted from remote OPML");
  }
  outline = { ...outline, extensions };

  const sourceType = normalizeSourceType(outline.type);
  if (outline.type && !isKnownType(outline.type)) {
    issue("adapted", "type-unknown", "type", `'${outline.type}' imported as plain RSS/Atom`);
  }
  if ((sourceType === "HTML+XPath" || sourceType === "XML+XPath") && !extensions.xPathItem) {
    issue("adapted", "scraper-incomplete", "xPathItem", `${sourceType} feed without an item selector cannot extract articles`);
  }
  if ((sourceType === "JSON+DotNotation" || sourceType === "HTML+XPath+JSON+DotNotation") && !extensions.jsonItem) {
    issue("adapted", "scraper-incomplete", "jsonItem", `${sourceType} feed without an item path cannot extract articles`);
  }

  let priority = "main";
  if (extensions.priority) {
    const given = extensions.priority.toLowerCase();
    if (PRIORITIES.has(given)) priority = given;
    else issue("adapted", "priority-invalid", "priority", `'${extensions.priority}' replaced by 'main'`);
  }
  if (priority === "feed" || priority === "hidden") {
    issue("adapted", "priority-hidden-approximated", "priority", `'${priority}': hidden from "All feeds", still listed in its category`);
  }

  let unicityCriteria = "id";
  if (extensions.unicityCriteria) {
    if (UNICITY_PATTERN.test(extensions.unicityCriteria)) unicityCriteria = extensions.unicityCriteria;
    else issue("adapted", "unicity-invalid", "unicityCriteria", "invalid value replaced by 'id'");
  }

  const scraper: FeedExtractionConfig = scraperConfigFromOutline(outline);
  const preserved: NonNullable<FeedExtractionConfig["preserved"]> = {};
  const unknown = unknownExtensions(extensions);
  if (unknown.length) {
    issue("preserved", "unknown-extension", unknown.map((name) => `frss:${name}`).join(", "), "kept on the feed and written back on export; no effect on fetching");
  }

  const http = httpOptionsFromOutline(outline);
  if (typeof http.CURLOPT_HTTPHEADER === "string") {
    const kept: string[] = [];
    const dropped: string[] = [];
    for (const line of http.CURLOPT_HTTPHEADER.split(/\r?\n|\r/).map((value) => value.trim()).filter(Boolean)) {
      const colon = line.indexOf(":");
      const name = colon > 0 ? line.slice(0, colon).trim() : "";
      // Only the header name goes into the report: values may be credentials.
      if (!/^[!#$%&'*+.^`|~\w-]+$/.test(name)) dropped.push(name ? "(invalid header)" : "(line without name)");
      else if (BLOCKED_REQUEST_HEADERS.has(name.toLowerCase())) dropped.push(name);
      else kept.push(line);
    }
    if (kept.length) http.CURLOPT_HTTPHEADER = kept.join("\n");
    else delete http.CURLOPT_HTTPHEADER;
    if (dropped.length) issue("unsupported", "http-header-dropped", "CURLOPT_HTTPHEADER", dropped.join(", "));
  }
  if (http.CURLOPT_MAXREDIRS !== undefined) {
    const redirects = Number(http.CURLOPT_MAXREDIRS);
    if (!Number.isInteger(redirects)) {
      delete http.CURLOPT_MAXREDIRS;
      issue("adapted", "maxredirs-invalid", "CURLOPT_MAXREDIRS", "ignored; default redirect limit applies");
    } else if (redirects < 0 || redirects > MAX_FEED_REDIRECTS) {
      http.CURLOPT_MAXREDIRS = Math.min(MAX_FEED_REDIRECTS, Math.max(0, redirects));
      issue("adapted", "maxredirs-clamped", "CURLOPT_MAXREDIRS", `${redirects} stored as ${http.CURLOPT_MAXREDIRS} (allowed 0–${MAX_FEED_REDIRECTS})`);
    }
  }
  if (http.CURLOPT_COOKIEFILE !== undefined) {
    delete http.CURLOPT_COOKIEFILE;
    issue("unsupported", "cookiefile-server-local", "CURLOPT_COOKIEFILE", "path on the FreshRSS server, not transferable");
  }
  if (trust === "remote") {
    const dropped = REMOTE_BLOCKED_HTTP.filter((name) => http[name] !== undefined);
    for (const name of dropped) delete http[name];
    if (dropped.length) issue("unsupported", "http-option-remote-dropped", dropped.join(", "), "not accepted from remote OPML");
  } else if (http.CURLOPT_PROXYTYPE !== undefined) {
    issue("adapted", "proxytype-ignored", "CURLOPT_PROXYTYPE", "proxy scheme is taken from the CURLOPT_PROXY URL");
  }

  const data: FeedWriteData = {
    name: outline.text,
    sourceType,
    htmlUrl: outline.htmlUrl || null,
    description: outline.description || null,
    priority,
    priorityGiven: priority !== "main" || extensions.priority?.toLowerCase() === "main",
    unicityCriteria,
    unicityCriteriaForced: /^(true|1|yes|on)$/i.test(extensions.unicityCriteriaForced ?? ""),
    scraperConfig: null,
    httpOptions: stringifyNonEmpty(http),
  };
  if (data.priorityGiven) data.hideFromAllFeeds = priority !== "main" && priority !== "important";
  if (typeof http.CURLOPT_USERAGENT === "string") data.customUserAgent = http.CURLOPT_USERAGENT;

  if (extensions.ttl !== undefined) {
    const seconds = Number(extensions.ttl);
    if (!/^\s*-?\d+\s*$/.test(extensions.ttl) || !Number.isSafeInteger(seconds)) {
      issue("adapted", "ttl-invalid", "ttl", `'${extensions.ttl}' ignored`);
    } else if (seconds !== 0) {
      const { minutes, exact } = ttlToMinutes(seconds);
      data.updateFrequency = minutes;
      if (!exact) {
        // Written back unchanged on export while the feed keeps this interval.
        preserved.ttl = String(seconds);
        issue("adapted", "ttl-clamped", "ttl", `${Math.abs(seconds)}s stored as ${minutes} min (allowed ${MIN_UPDATE_MINUTES}–${MAX_UPDATE_MINUTES} min)`);
      }
      if (seconds < 0) data.mute = true;
    }
  }

  if (extensions.cssFullContent) {
    data.fullTextSelector = extensions.cssFullContent;
    data.enableSelectorMode = true;
  }
  const remove = extensions.cssContentFilter || extensions.cssFullContentFilter;
  if (remove) data.fullTextRemoveSelectors = remove;
  if (extensions.cssFullContentConditions) {
    data.fullTextConditions = extensions.cssFullContentConditions;
    const conditions = translateFreshRssReadFilters(extensions.cssFullContentConditions);
    if (conditions.unsupported.length) {
      issue(
        "adapted",
        "css-conditions-partial",
        "cssFullContentConditions",
        `${conditions.unsupported.map(({ line }) => line).join(" | ")} — cannot be evaluated, so full text is fetched for every article`,
      );
    }
  }
  // cssContentFilter alone is fine (it cleans the feed's own content); conditions only
  // gate a full-text download, which needs a content selector.
  if (extensions.cssFullContentConditions && !extensions.cssFullContent) {
    issue("adapted", "css-without-selector", "cssFullContentConditions", "conditions stored, but without a content selector there is no full-text download to gate");
  }

  let ruleQuery: string | null = null;
  if (extensions.filtersActionRead !== undefined) {
    const translation = translateFreshRssReadFilters(extensions.filtersActionRead);
    data.filtersActionRead = translation.keywordLines.join("\n") || null;
    // Every line that is not a plain keyword (rule-translated or not translatable) is kept
    // verbatim so an export to FreshRSS carries the original filter text.
    const keywords = new Set(translation.keywordLines);
    const otherLines = extensions.filtersActionRead
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter((line) => line && !keywords.has(line) && !keywords.has(line.replace(/^"(.*)"$|^'(.*)'$/, "$1$2")));
    if (otherLines.length) preserved.filtersActionRead = [...new Set(otherLines)].join("\n");
    for (const { line, reason } of translation.unsupported) {
      issue("unsupported", "filter-untranslatable", "filtersActionRead", `${line} — ${reason}`);
    }
    if (translation.ruleQueries.length) {
      const query = translation.ruleQueries.join(" OR ");
      if (query.length > MAX_SEARCH_QUERY) {
        issue("unsupported", "filter-too-long", "filtersActionRead", `translated query exceeds ${MAX_SEARCH_QUERY} characters`);
      } else if (trust === "remote") {
        issue("unsupported", "filter-rule-remote-dropped", "filtersActionRead", "auto-read rules are not created from remote OPML");
      } else {
        ruleQuery = query;
        issue("adapted", "filter-rule-created", "filtersActionRead", `imported as auto-read rule: ${query}`);
      }
    }
  }

  if (Object.keys(preserved).length) scraper.preserved = preserved;
  data.scraperConfig = stringifyNonEmpty(scraper);

  return { url: feedUrl, name: outline.text, data, ruleQuery };
}

export function planOpmlImport(outlines: OpmlOutline[], options: { trust?: ImportTrust } = {}): OpmlImportPlan {
  const trust = options.trust ?? "local";
  const plan: OpmlImportPlan = { trust, categories: [], feeds: [], issues: [], errors: [] };
  const categoryByName = new Map<string, PlannedCategory>();

  const categoryNode = (name: string, opmlUrl: string | null, container: PlannedCategory[], key: string) => {
    let node = categoryByName.get(key);
    if (!node) {
      node = { name, opmlUrl, children: [], feeds: [] };
      categoryByName.set(key, node);
      container.push(node);
    } else if (opmlUrl) {
      node.opmlUrl = opmlUrl;
    }
    return node;
  };

  const isFeedOutline = (outline: OpmlOutline) => Boolean(outline.xmlUrl) || (!outline.children?.length && /^(rss|atom)$/i.test(outline.type ?? ""));

  const walk = (outline: OpmlOutline, container: PlannedCategory | null, path: string) => {
    if (isFeedOutline(outline)) {
      const feed = mapOutlineToFeed(outline, trust, plan.issues);
      if (!feed) {
        plan.errors.push(`${outline.text}: invalid or missing feed URL`);
        return;
      }
      let target = container;
      if (!target && outline.category) {
        target = categoryNode(outline.category, null, plan.categories, `/${outline.category}`);
      }
      (target ? target.feeds : plan.feeds).push(feed);
      return;
    }

    // Category — including empty ones (`<outline text="Empty"/>`).
    let opmlUrl = outline.extensions?.opmlUrl ?? null;
    if (opmlUrl && trust === "remote") {
      plan.issues.push({ kind: "unsupported", code: "nested-dynamic-opml-dropped", subject: outline.text, attribute: "opmlUrl", detail: "dynamic categories are not followed from remote OPML" });
      opmlUrl = null;
    }
    const key = `${path}/${outline.text}`;
    const node = categoryNode(outline.text, opmlUrl, container ? container.children : plan.categories, key);
    for (const child of outline.children ?? []) walk(child, node, key);
  };

  for (const outline of outlines) walk(outline, null, "");
  return plan;
}

// ── Phase 2: user-scoped writes ──────────────────────────────────────────────

export interface ApplyOptions {
  dryRun?: boolean;
  /** Attach the whole plan below this (already user-owned) category instead of the root. */
  parentCategoryId?: string | null;
  onProgress?: (progress: { phase: "opml"; done: number; total: number }) => void;
}

function countFeeds(plan: { categories: PlannedCategory[]; feeds: PlannedFeed[] }): number {
  const walk = (categories: PlannedCategory[]): number =>
    categories.reduce((sum, category) => sum + category.feeds.length + walk(category.children), 0);
  return plan.feeds.length + walk(plan.categories);
}

export async function applyOpmlImportPlan(
  userId: string,
  plan: OpmlImportPlan,
  options: ApplyOptions = {},
): Promise<OpmlImportReport> {
  const dryRun = options.dryRun === true;
  const report = emptyReport(dryRun);
  report.issues = [...plan.issues];
  report.errors = [...plan.errors];
  const total = countFeeds(plan);
  let done = 0;
  const secretRules = await getConnectorSecretRules();

  const writeFeed = async (feed: PlannedFeed, categoryId: string | null, pending: boolean, order: number) => {
    // Connector feeds: only allowed routes (no /rsshub/transform/…, no
    // all-watches feed), stored without the RSSHub key / changedetection token (N3).
    const connectorError = connectorFeedUrlErrorWith(secretRules, feed.url);
    if (connectorError) {
      report.issues.push({ kind: "unsupported", code: "connector-route-blocked", subject: feed.name, attribute: "xmlUrl", detail: connectorError });
      return;
    }
    const feedUrl = stripConnectorSecretsWith(secretRules, feed.url);
    const existing = pending
      ? null
      : await db.feed.findUnique({
          where: { userId_url: { userId, url: feedUrl } },
          select: { id: true, fullTextMode: true },
        });
    if (existing) report.feedsUpdated += 1;
    else report.feedsAdded += 1;

    const d = feed.data;
    // FreshRSS stores CURLOPT_PROXY as curl does: often bare `host:port`, with the
    // scheme implied by CURLOPT_PROXYTYPE (0/absent = HTTP, 2 = HTTPS, 4–7 = SOCKS).
    // Give HTTP(S) proxies an explicit scheme; SOCKS is not supported by the fetcher.
    if (d.httpOptions) {
      const options = JSON.parse(d.httpOptions) as Record<string, unknown>;
      const proxy = typeof options.CURLOPT_PROXY === "string" ? options.CURLOPT_PROXY.trim() : "";
      if (proxy && !proxy.includes("://")) {
        const type = Number(options.CURLOPT_PROXYTYPE ?? 0);
        if (type >= 4 && type <= 7) {
          delete options.CURLOPT_PROXY;
          delete options.CURLOPT_PROXYTYPE;
          report.issues.push({
            kind: "unsupported",
            code: "proxy-socks",
            subject: feed.name,
            attribute: "CURLOPT_PROXYTYPE",
            detail: "SOCKS proxies are not supported — proxy not imported",
          });
        } else {
          options.CURLOPT_PROXY = `${type === 2 ? "https" : "http"}://${proxy}`;
        }
        d.httpOptions = stringifyNonEmpty(options);
      }
    }
    // A proxy host is a connection target: same SSRF rules as feed URLs. An unsafe one is
    // dropped (and reported) instead of failing the whole import; the rest of the feed imports.
    if (d.httpOptions && proxyFromHttpOptions(d.httpOptions)) {
      try {
        await assertSafeHttpOptionsProxy(d.httpOptions);
      } catch (error) {
        const options = JSON.parse(d.httpOptions) as Record<string, unknown>;
        delete options.CURLOPT_PROXY;
        delete options.CURLOPT_PROXYTYPE;
        d.httpOptions = stringifyNonEmpty(options);
        report.issues.push({
          kind: "unsupported",
          code: "proxy-blocked",
          subject: feed.name,
          attribute: "CURLOPT_PROXY",
          detail: `${error instanceof Error ? error.message : "unsafe proxy"} — proxy not imported`,
        });
      }
    }
    // Creating a feed writes every field. Updating an existing feed writes only what the
    // outline actually carries: a bare outline (or a remote dynamic-OPML sync) must not
    // blank the name, description, priority, scraper config or HTTP options set locally.
    // Remote syncs never touch httpOptions of an existing feed at all (cookies/proxy/headers
    // are user-owned; a third-party list may not rewrite them).
    const keep = existing !== null;
    const common = {
      ...(!keep || d.name ? { name: d.name } : {}),
      sourceType: d.sourceType,
      ...(!keep || d.htmlUrl ? { htmlUrl: d.htmlUrl } : {}),
      ...(!keep || d.description ? { description: d.description } : {}),
      ...(!keep || d.priorityGiven ? { priority: d.priority } : {}),
      unicityCriteria: d.unicityCriteria,
      unicityCriteriaForced: d.unicityCriteriaForced,
      ...(!keep || d.scraperConfig !== null ? { scraperConfig: d.scraperConfig } : {}),
      ...(!keep || (d.httpOptions !== null && plan.trust !== "remote") ? { httpOptions: d.httpOptions } : {}),
      ...(categoryId !== null || !existing ? { categoryId } : {}),
      ...(d.filtersActionRead !== undefined ? { filtersActionRead: d.filtersActionRead } : {}),
      ...(d.fullTextSelector !== undefined ? { fullTextSelector: d.fullTextSelector } : {}),
      ...(d.fullTextConditions !== undefined ? { fullTextConditions: d.fullTextConditions } : {}),
      ...(d.fullTextRemoveSelectors !== undefined ? { fullTextRemoveSelectors: d.fullTextRemoveSelectors } : {}),
      ...(d.hideFromAllFeeds !== undefined ? { hideFromAllFeeds: d.hideFromAllFeeds } : {}),
      ...(d.updateFrequency !== undefined ? { updateFrequency: d.updateFrequency } : {}),
      ...(d.mute ? { autoMuted: true } : {}),
      ...(d.customUserAgent ? { customUserAgent: d.customUserAgent } : {}),
    };
    // Selector extraction is turned on only from "off": never downgrade "auto"/"ai".
    const modeOnCreate = d.enableSelectorMode ? { fullTextMode: "selector" } : {};
    const modeOnUpdate = d.enableSelectorMode && (existing?.fullTextMode ?? "off") === "off" ? { fullTextMode: "selector" } : {};

    if (dryRun) {
      if (feed.ruleQuery) report.rulesCreated += 1;
      return;
    }

    let feedId: string;
    if (existing) {
      await db.feed.update({ where: { id: existing.id }, data: { ...common, ...modeOnUpdate } });
      feedId = existing.id;
    } else {
      const created = await db.feed.create({ data: { userId, url: feedUrl, order, ...common, name: d.name, ...modeOnCreate } });
      feedId = created.id;
    }

    if (feed.ruleQuery) await upsertFeedRule(userId, feedId, feed.name, feed.ruleQuery, report);
  };

  const writeCategory = async (
    node: PlannedCategory,
    parentId: string | null,
    parentPending: boolean,
    order: number,
  ) => {
    let id: string | null = null;
    let pending = parentPending;
    const existing = parentPending
      ? null
      : await db.category.findFirst({ where: { userId, name: node.name, parentId } });
    if (existing) {
      report.categoriesUpdated += 1;
      id = existing.id;
      if (!dryRun && node.opmlUrl) await db.category.update({ where: { id }, data: { opmlUrl: node.opmlUrl } });
    } else {
      report.categoriesAdded += 1;
      pending = true;
      if (!dryRun) {
        const created = await db.category.create({
          data: { userId, name: node.name, parentId, order, opmlUrl: node.opmlUrl ?? undefined },
        });
        id = created.id;
        pending = false;
      }
    }

    let index = 0;
    for (const feed of node.feeds) {
      try {
        await writeFeed(feed, id, pending, index++);
      } catch (error) {
        report.errors.push(`${feed.name}: ${error instanceof Error ? error.message : String(error)}`);
      }
      options.onProgress?.({ phase: "opml", done: ++done, total });
    }
    let childIndex = 0;
    for (const child of node.children) {
      try {
        await writeCategory(child, id, pending, childIndex++);
      } catch (error) {
        report.errors.push(`${child.name}: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
  };

  const rootId = options.parentCategoryId ?? null;
  let feedIndex = 0;
  for (const feed of plan.feeds) {
    try {
      await writeFeed(feed, rootId, false, feedIndex++);
    } catch (error) {
      report.errors.push(`${feed.name}: ${error instanceof Error ? error.message : String(error)}`);
    }
    options.onProgress?.({ phase: "opml", done: ++done, total });
  }
  let categoryIndex = 0;
  for (const node of plan.categories) {
    try {
      await writeCategory(node, rootId, false, categoryIndex++);
    } catch (error) {
      report.errors.push(`${node.name}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  return report;
}

async function upsertFeedRule(
  userId: string,
  feedId: string,
  feedName: string,
  query: string,
  report: OpmlImportReport,
) {
  const scope = `feed:${feedId}`;
  const name = `FreshRSS filter: ${feedName}`.slice(0, 200);
  const existing = await db.autoReadRule.findFirst({ where: { userId, scope, name }, select: { id: true } });
  if (existing) {
    await db.autoReadRule.update({ where: { id: existing.id }, data: { query } });
    report.rulesUpdated += 1;
    return;
  }
  await db.autoReadRule.create({
    data: { userId, name, query, action: "mark_read", actions: JSON.stringify(["mark_read"]), scope, trigger: "article", enabled: true },
  });
  report.rulesCreated += 1;
}

// ── Convenience entry for string callers ─────────────────────────────────────

export class OpmlImportInputError extends Error {}

/** How long a real OPML import waits for the shared import slot before `ImportBusyError`. */
export const OPML_IMPORT_SLOT_WAIT_MS = 15_000;

export async function importOpmlXml(
  userId: string,
  xml: string,
  options: ApplyOptions & { trust?: ImportTrust; maxFeeds?: number } = {},
): Promise<OpmlImportReport> {
  const sizeError = validateOpml(xml);
  if (sizeError) throw new OpmlImportInputError(sizeError);
  const outlines = await parseOpml(xml);
  const plan = planOpmlImport(outlines, { trust: options.trust });
  if (options.maxFeeds !== undefined && countFeeds(plan) > options.maxFeeds) throw new OpmlImportInputError("Too many feeds");
  // N9: shares the instance-wide import slot with the FreshRSS migration. OPML runs are
  // short, so wait a little for a slot instead of failing at once.
  return withImportSlot(userId, () => applyOpmlImportPlan(userId, plan, options), { waitMs: OPML_IMPORT_SLOT_WAIT_MS });
}
