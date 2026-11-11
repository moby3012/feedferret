import { guardHtml } from "@/lib/html-guard";
import { HtmlTaskFailedError, isHtmlWorkerError, runHtmlTask } from "@/lib/html-worker/pool";
import { OpmlParseError, assertSafeOpmlXml, type OpmlOutline } from "./opml-shared";
import { readPlainColumnOrNull } from "@/lib/secret-box";
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

function feedExtensionAttributes(feed: any) {
    const scraper = parseJsonObject<FeedExtractionConfig>(feed.scraperConfig);
    // httpOptions may be v2-sealed (M8); unreadable values are left out of the export.
    const httpOptions = parseJsonObject<FeedHttpOptions>(readPlainColumnOrNull("feed.httpOptions", feed.httpOptions));
    let out = "";

    out += extensionsAttr("priority", feed.priority && feed.priority !== "main" ? feed.priority : undefined);
    out += extensionsAttr("unicityCriteria", feed.unicityCriteria && feed.unicityCriteria !== "id" ? feed.unicityCriteria : undefined);
    out += extensionsAttr("unicityCriteriaForced", feed.unicityCriteriaForced ? "true" : undefined);

    for (const name of XPATH_ATTRS) out += extensionsAttr(name, scraper.xpath?.[name]);
    for (const name of JSON_ATTRS) out += extensionsAttr(name, scraper.json?.[name]);
    out += extensionsAttr("xPathToJson", scraper.xPathToJson);

    out += extensionsAttr("filtersActionRead", feed.filtersActionRead);
    out += extensionsAttr("cssFullContent", feed.fullTextSelector);
    out += extensionsAttr("cssFullContentConditions", feed.fullTextConditions);
    out += extensionsAttr("cssContentFilter", feed.fullTextRemoveSelectors);

    for (const name of HTTP_ATTRS) out += extensionsAttr(name, httpOptions[name]);

    // Refresh interval in seconds; negative = muted (FreshRSS convention).
    if (feed.updateFrequency) out += extensionsAttr("ttl", feed.updateFrequency * 60 * (feed.autoMuted ? -1 : 1));

    // Extension attributes this version does not understand are kept verbatim.
    for (const [name, value] of Object.entries(scraper.extensions ?? {})) {
        if (/^[A-Za-z_][\w.-]*$/.test(name)) out += extensionsAttr(name, value);
    }

    return out;
}

function feedOutline(feed: any, indent: string) {
    const type = normalizeSourceType(feed.sourceType || "rss");
    return `${indent}<outline text="${escapeXml(feed.name)}" title="${escapeXml(feed.name)}" type="${escapeXml(type)}" xmlUrl="${escapeXml(feed.url)}"${attr("htmlUrl", feed.htmlUrl || feed.url)}${attr("description", feed.description)}${feedExtensionAttributes(feed)}/>`;
}

function categoryOutline(category: any, lines: string[], indent: string, childrenByParent: Map<string | null, any[]>, feedsByCategory: Map<string | null, any[]>) {
    const children = childrenByParent.get(category.id) ?? [];
    const feeds = feedsByCategory.get(category.id) ?? [];
    lines.push(`${indent}<outline text="${escapeXml(category.name)}" title="${escapeXml(category.name)}"${extensionsAttr("opmlUrl", category.opmlUrl)}>`);
    for (const child of children) categoryOutline(child, lines, `${indent}  `, childrenByParent, feedsByCategory);
    for (const feed of feeds) lines.push(feedOutline(feed, `${indent}  `));
    lines.push(`${indent}</outline>`);
}

/**
 * Generates an OPML string from feeds and optional categories. When categories
 * are provided, Scout Studio dynamic OPML categories and nested structure are kept.
 */
/** API exports expose only public subscription configuration. Unknown HTTP and
 * scraper extensions are omitted: they can carry arbitrary credentials. */
export function generateApiOpml(feeds: any[], categories: any[] = []) {
    const publicUrl = (value: string | null) => value?.replace(/(https?:\/\/)[^/@]+@/gi, "$1") ?? value;
    return generateOpml(feeds.map((feed) => {
        const scraper = parseJsonObject<FeedExtractionConfig>(feed.scraperConfig);
        delete scraper.extensions;
        return { ...feed, url: publicUrl(feed.url), htmlUrl: publicUrl(feed.htmlUrl),
            httpOptions: null, authPassword: null, scraperConfig: JSON.stringify(scraper) };
    }), categories.map((category) => ({ ...category, opmlUrl: publicUrl(category.opmlUrl) })));
}

export function generateOpml(feeds: any[], categories: any[] = []): string {
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
    for (const feed of feedsByCategory.get(null) ?? []) lines.push(feedOutline(feed, "    "));

    if (categories.length > 0) {
        const childrenByParent = new Map<string | null, any[]>();
        for (const category of categories) {
            const key = category.parentId ?? null;
            if (!childrenByParent.has(key)) childrenByParent.set(key, []);
            childrenByParent.get(key)!.push(category);
        }
        for (const root of childrenByParent.get(null) ?? []) {
            categoryOutline(root, lines, "    ", childrenByParent, feedsByCategory);
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
            for (const feed of catFeeds) lines.push(feedOutline(feed, "      "));
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
    return unsafe.replace(XML_ILLEGAL_CHARS, "").replace(/[<>&"']/g, (c) => {
        switch (c) {
            case '<': return '&lt;';
            case '>': return '&gt;';
            case '&': return '&amp;';
            case '"': return '&quot;';
            case "'": return '&apos;';
            default: return c;
        }
    });
}
