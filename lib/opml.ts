import { guardHtml } from "@/lib/html-guard";
import { HtmlTaskFailedError, isHtmlWorkerError, runHtmlTask } from "@/lib/html-worker/pool";
import { OpmlParseError, assertSafeOpmlXml, type OpmlOutline } from "./opml-shared";
import { readPlainColumnOrNull } from "@/lib/secret-box";
import { resolveFullTextMode } from "@/lib/full-text-mode";
import {
    OPML_EXTENSION_NAMESPACE,
    OPML_EXTENSION_PREFIX,
    HTTP_ATTRS,
    JSON_ATTRS,
    XPATH_ATTRS,
    FeedHttpOptions,
    FeedExtractionConfig,
    normalizeSourceType,
    parseBooleanLike,
    parseIntLike,
    parseJsonObject,
} from "./feed-extraction";

// Parsing lives in lib/opml-parse-core.ts (runs in the HTML worker pool).
export { OPML_PARSE_LIMITS, OpmlParseError, assertSafeOpmlXml, type OpmlOutline } from "./opml-shared";

/**
 * Parses an OPML string into a hierarchical list of outlines, preserving Scout Studio
 * extended attributes under `outline.extensions`. Cheap checks (entities / DTD,
 * outline count, nesting / element work) run here; the jsdom parse runs in the
 * HTML worker pool (lib/opml-parse-core.ts). Every failure is an OpmlParseError.
 */
export async function parseOpml(xml: string): Promise<OpmlOutline[]> {
    const source = xml.charCodeAt(0) === 0xfeff ? xml.slice(1) : xml;
    assertSafeOpmlXml(source);
    const guard = guardHtml(source, { xml: true, maxChars: Number.MAX_SAFE_INTEGER, maxDepth: 256 });
    if (guard.truncatedBy) {
        throw new OpmlParseError(`OPML document is too deeply nested or too complex to parse (${guard.truncatedBy})`);
    }
    try {
        return await runHtmlTask("parseOpml", source);
    } catch (error) {
        if (error instanceof HtmlTaskFailedError && error.originalName === "OpmlParseError") throw new OpmlParseError(error.message);
        if (isHtmlWorkerError(error)) {
            throw new OpmlParseError(
                error.reason === "unavailable"
                    ? "OPML parsing is unavailable on this server right now (administrator: see /api/health)"
                    : error.reason === "busy"
                      ? "The server is busy; try the OPML import again in a moment"
                      : `OPML document is too complex to parse (${error.reason})`,
            );
        }
        throw error;
    }
}

function attr(name: string, value: unknown) {
    if (value === null || value === undefined || value === "") return "";
    return ` ${name}="${escapeXml(String(value))}"`;
}

function extensionsAttr(name: string, value: unknown) {
    return attr(`${OPML_EXTENSION_PREFIX}:${name}`, value);
}

export interface OpmlExportOptions {
    /** Refresh interval (minutes) of feeds without their own; used for the TTL of muted feeds. */
    defaultUpdateFrequency?: number;
    /**
     * Include credentials and request options that may carry them: cookies, HTTP headers,
     * POST bodies, proxy settings, user:pass in URLs and unknown `frss:*` values. Off by
     * default; only an explicit opt-in of the signed-in owner turns it on.
     */
    includeCredentials?: boolean;
}

/** cURL options without secrets: kept in the default (credential-free) export. */
const SHAREABLE_HTTP_OPTIONS = new Set(["CURLOPT_USERAGENT", "CURLOPT_FOLLOWLOCATION", "CURLOPT_MAXREDIRS"]);

const stripUserinfo = (value: string | null | undefined) => value?.replace(/(https?:\/\/)[^/@?#]+@/gi, "$1") ?? value;

function redactFeedForShareableExport(feed: any) {
    const scraper = parseJsonObject<FeedExtractionConfig>(feed.scraperConfig);
    delete scraper.extensions;
    const http = parseJsonObject<FeedHttpOptions>(readPlainColumnOrNull("feed.httpOptions", feed.httpOptions));
    const safeHttp = Object.fromEntries(Object.entries(http).filter(([name]) => SHAREABLE_HTTP_OPTIONS.has(name)));
    return {
        ...feed,
        url: stripUserinfo(feed.url),
        htmlUrl: stripUserinfo(feed.htmlUrl),
        httpOptions: Object.keys(safeHttp).length ? JSON.stringify(safeHttp) : null,
        authUsername: null,
        authPassword: null,
        scraperConfig: JSON.stringify(scraper),
    };
}

/** FreshRSS priority for a feed; FeedFerret's "hide from All feeds" is FreshRSS' "category". */
export function exportPriority(feed: { priority?: string | null; hideFromAllFeeds?: boolean | null }) {
    const priority = feed.priority || "main";
    if (priority === "main" && feed.hideFromAllFeeds) return "category";
    return priority === "main" ? undefined : priority;
}

/**
 * Signed FreshRSS TTL in seconds (negative = muted, refresh disabled). A value that
 * FeedFerret had to round or clamp on import is written back verbatim as long as the
 * feed still carries the interval it was mapped to.
 */
export function exportTtl(
    feed: { updateFrequency?: number | null; autoMuted?: boolean | null },
    preservedTtl: string | undefined,
    options: OpmlExportOptions,
) {
    const muted = Boolean(feed.autoMuted);
    if (!feed.updateFrequency && !muted) return undefined;
    if (preservedTtl !== undefined && /^-?\d+$/.test(preservedTtl)) {
        const seconds = Number(preservedTtl);
        if ((seconds < 0) === muted && ttlToMinutes(seconds).minutes === feed.updateFrequency) return preservedTtl;
    }
    const minutes = feed.updateFrequency || options.defaultUpdateFrequency || 60;
    return String(minutes * 60 * (muted ? -1 : 1));
}

export const MIN_UPDATE_MINUTES = 5;
export const MAX_UPDATE_MINUTES = 10_080;

/** Maps a FreshRSS TTL (seconds) onto FeedFerret's refresh interval range (minutes). */
export function ttlToMinutes(seconds: number) {
    const exact = Math.abs(seconds) / 60;
    const minutes = Math.min(MAX_UPDATE_MINUTES, Math.max(MIN_UPDATE_MINUTES, Math.ceil(exact)));
    return { minutes, exact: minutes === exact };
}

/** Read-filter lines for `frss:filtersActionRead`: FeedFerret keywords plus the preserved FreshRSS lines. */
export function exportReadFilters(keywords: string | null | undefined, preserved: string | undefined) {
    const lines: string[] = [];
    const seen = new Set<string>();
    // FeedFerret keywords are literal substrings; FreshRSS would read spaces, `OR`,
    // `field:`, a leading `-`/`!`/`#` or `/…/` as search syntax, so such keywords are quoted.
    const keywordLines = (keywords ?? "").split(/\r?\n/).map((line) => {
        const keyword = line.trim();
        const needsQuotes = /[\s:()]|^[-!#/]/.test(keyword) || keyword.toUpperCase() === "OR";
        if (!keyword || !needsQuotes) return keyword;
        return keyword.includes('"') ? (keyword.includes("'") ? keyword : `'${keyword}'`) : `"${keyword}"`;
    });
    for (const line of [...keywordLines, ...(preserved ?? "").split(/\r?\n/)]) {
        const trimmed = line.trim();
        if (!trimmed || seen.has(trimmed)) continue;
        seen.add(trimmed);
        lines.push(trimmed);
    }
    return lines.join("\n") || undefined;
}

function feedExtensionAttributes(feed: any, options: OpmlExportOptions) {
    const scraper = parseJsonObject<FeedExtractionConfig>(feed.scraperConfig);
    // httpOptions may be v2-sealed (M8); unreadable values are left out of the export.
    const httpOptions = parseJsonObject<FeedHttpOptions>(readPlainColumnOrNull("feed.httpOptions", feed.httpOptions));
    if (httpOptions.CURLOPT_USERAGENT === undefined && feed.customUserAgent) httpOptions.CURLOPT_USERAGENT = feed.customUserAgent;
    const emitted = new Set<string>();
    let out = "";
    const emit = (name: string, value: unknown) => {
        const rendered = extensionsAttr(name, value);
        if (rendered) emitted.add(name);
        out += rendered;
    };

    emit("priority", exportPriority(feed));
    emit("unicityCriteria", feed.unicityCriteria && feed.unicityCriteria !== "id" ? feed.unicityCriteria : undefined);
    emit("unicityCriteriaForced", feed.unicityCriteriaForced ? "true" : undefined);
    emit("ttl", exportTtl(feed, scraper.preserved?.ttl, options));

    for (const name of XPATH_ATTRS) emit(name, scraper.xpath?.[name]);
    for (const name of JSON_ATTRS) emit(name, scraper.json?.[name]);
    emit("xPathToJson", scraper.xPathToJson);

    emit("contentRules", feed.contentRules);
    emit("filtersActionRead", exportReadFilters(feed.filtersActionRead, scraper.preserved?.filtersActionRead));
    // In FreshRSS a non-empty selector *is* the switch for full-content download, so a
    // selector kept on a feed whose full text is turned off must not be exported.
    if (resolveFullTextMode(feed) !== "off") emit("cssFullContent", feed.fullTextSelector);
    emit("cssFullContentConditions", feed.fullTextConditions);
    emit("cssContentFilter", feed.fullTextRemoveSelectors);

    for (const name of HTTP_ATTRS) emit(name, httpOptions[name]);

    // Extension attributes this version does not understand are kept verbatim (never
    // twice: a duplicate attribute makes the whole document invalid XML).
    for (const [name, value] of Object.entries(scraper.extensions ?? {})) {
        if (/^[A-Za-z_][\w.-]*$/.test(name) && !emitted.has(name)) emit(name, value);
    }

    return out;
}

function feedOutline(feed: any, indent: string, options: OpmlExportOptions) {
    const type = normalizeSourceType(feed.sourceType || "rss");
    return `${indent}<outline text="${escapeXml(feed.name)}" title="${escapeXml(feed.name)}" type="${escapeXml(type)}" xmlUrl="${escapeXml(feed.url)}"${attr("htmlUrl", feed.htmlUrl || feed.url)}${attr("description", feed.description)}${feedExtensionAttributes(feed, options)}/>`;
}

function categoryOutline(category: any, lines: string[], indent: string, childrenByParent: Map<string | null, any[]>, feedsByCategory: Map<string | null, any[]>, options: OpmlExportOptions) {
    const children = childrenByParent.get(category.id) ?? [];
    const feeds = feedsByCategory.get(category.id) ?? [];
    lines.push(`${indent}<outline text="${escapeXml(category.name)}" title="${escapeXml(category.name)}"${extensionsAttr("opmlUrl", category.opmlUrl)}>`);
    for (const child of children) categoryOutline(child, lines, `${indent}  `, childrenByParent, feedsByCategory, options);
    for (const feed of feeds) lines.push(feedOutline(feed, `${indent}  `, options));
    lines.push(`${indent}</outline>`);
}

/** API exports (REST, GReader) are always the credential-free variant. */
export function generateApiOpml(feeds: any[], categories: any[] = [], options: OpmlExportOptions = {}) {
    return generateOpml(feeds, categories, { ...options, includeCredentials: false });
}

/**
 * Generates an OPML string from feeds and optional categories. When categories
 * are provided, Scout Studio dynamic OPML categories and nested structure are kept.
 * Credential-free unless `options.includeCredentials` is true.
 */
export function generateOpml(feeds: any[], categories: any[] = [], options: OpmlExportOptions = {}): string {
    if (options.includeCredentials !== true) {
        feeds = feeds.map(redactFeedForShareableExport);
        categories = categories.map((category) => ({ ...category, opmlUrl: stripUserinfo(category.opmlUrl) }));
    }
    const header = `<?xml version="1.0" encoding="UTF-8"?>
<opml version="2.0" xmlns:${OPML_EXTENSION_PREFIX}="${OPML_EXTENSION_NAMESPACE}">
  <head>
    <title>FeedFerret Subscriptions</title>
    <dateCreated>${new Date().toUTCString()}</dateCreated>
  </head>
  <body>`;

    const footer = `
  </body>
</opml>`;

    const feedsByCategory = new Map<string | null, any[]>();
    for (const feed of feeds) {
        const key = feed.categoryId ?? null;
        if (!feedsByCategory.has(key)) feedsByCategory.set(key, []);
        feedsByCategory.get(key)!.push(feed);
    }

    const lines: string[] = [];
    for (const feed of feedsByCategory.get(null) ?? []) lines.push(feedOutline(feed, "    ", options));

    if (categories.length > 0) {
        const childrenByParent = new Map<string | null, any[]>();
        for (const category of categories) {
            const key = category.parentId ?? null;
            if (!childrenByParent.has(key)) childrenByParent.set(key, []);
            childrenByParent.get(key)!.push(category);
        }
        for (const root of childrenByParent.get(null) ?? []) {
            categoryOutline(root, lines, "    ", childrenByParent, feedsByCategory, options);
        }
    } else {
        const byName = new Map<string, any[]>();
        for (const feed of feeds.filter((f) => f.category?.name)) {
            const key = feed.category.name;
            if (!byName.has(key)) byName.set(key, []);
            byName.get(key)!.push(feed);
        }
        for (const [catName, catFeeds] of byName) {
            lines.push(`    <outline text="${escapeXml(catName)}" title="${escapeXml(catName)}">`);
            for (const feed of catFeeds) lines.push(feedOutline(feed, "      ", options));
            lines.push(`    </outline>`);
        }
    }

    return header + "\n" + lines.join("\n") + footer;
}

/** Extension attribute names this version maps to a FeedFerret field (everything else is "unknown"). */
let knownExtensionNames: ReadonlySet<string> | null = null;
export function getKnownExtensionNames(): ReadonlySet<string> {
    // Built lazily: some test suites replace ./feed-extraction with an empty mock.
    knownExtensionNames ??= new Set([
        "opmlUrl",
        "priority",
        "unicityCriteria",
        "unicityCriteriaForced",
        "xPathToJson",
        "contentRules",
        "filtersActionRead",
        "cssFullContent",
        "cssFullContentConditions",
        "cssContentFilter",
        "cssFullContentFilter",
        "ttl",
        ...XPATH_ATTRS,
        ...JSON_ATTRS,
        ...HTTP_ATTRS,
    ]);
    return knownExtensionNames;
}

export function unknownExtensions(extensions: Record<string, string>): string[] {
    const known = getKnownExtensionNames();
    return Object.keys(extensions).filter((name) => !known.has(name));
}

export function scraperConfigFromOutline(outline: OpmlOutline) {
    const extensions = outline.extensions ?? {};
    const xpath: Record<string, string> = {};
    const json: Record<string, string> = {};
    for (const name of XPATH_ATTRS) if (extensions[name]) xpath[name] = extensions[name];
    for (const name of JSON_ATTRS) if (extensions[name]) json[name] = extensions[name];
    return {
        ...(Object.keys(xpath).length ? { xpath } : {}),
        ...(Object.keys(json).length ? { json } : {}),
        ...(extensions.xPathToJson ? { xPathToJson: extensions.xPathToJson } : {}),
        ...(unknownExtensions(extensions).length
            ? { extensions: Object.fromEntries(unknownExtensions(extensions).map((name) => [name, extensions[name]])) }
            : {}),
    } satisfies FeedExtractionConfig;
}

export function httpOptionsFromOutline(outline: OpmlOutline) {
    const extensions = outline.extensions ?? {};
    const http: FeedHttpOptions = {};
    for (const name of HTTP_ATTRS) {
        const value = extensions[name];
        if (!value) continue;
        if (["CURLOPT_FOLLOWLOCATION", "CURLOPT_POST"].includes(name)) http[name] = parseBooleanLike(value);
        else if (["CURLOPT_MAXREDIRS", "CURLOPT_PROXYTYPE"].includes(name)) http[name] = parseIntLike(value) ?? value;
        else http[name] = value;
    }
    return http;
}

// XML 1.0's Char production excludes most C0 controls outright (tab/LF/CR are
// the only ones allowed) — unlike <, &, etc. these can't be made legal by
// escaping them, so they have to be dropped instead. Malformed RSS/Atom feed
// metadata occasionally carries these (e.g. a stray NUL or vertical-tab byte
// in a title), and previously a single such feed produced an OPML document
// that our own parseOpml() (JSDOM, text/xml) throws a SyntaxError on,
// poisoning the entire export for everyone else's feeds too.
const XML_ILLEGAL_CHARS = /[\x00-\x08\x0B\x0C\x0E-\x1F]/g;

function escapeXml(unsafe: string): string {
    // Tab/LF/CR must be character references: a literal one inside an attribute value is
    // normalised to a space by every XML parser, which would join multi-line values
    // (read filters, HTTP headers, full-text conditions, multi-line XPath) into one line.
    return unsafe.replace(XML_ILLEGAL_CHARS, "").replace(/[<>&"'\t\n\r]/g, (c) => {
        switch (c) {
            case '\t': return '&#9;';
            case '\n': return '&#10;';
            case '\r': return '&#13;';
            case '<': return '&lt;';
            case '>': return '&gt;';
            case '&': return '&amp;';
            case '"': return '&quot;';
            case "'": return '&apos;';
            default: return c;
        }
    });
}
