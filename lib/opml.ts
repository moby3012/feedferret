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

/** Hard limits for untrusted OPML documents (UI upload, REST, MCP, ZIP, remote dynamic OPML). */
export const OPML_PARSE_LIMITS = {
    maxOutlines: 20_000,
    maxDepth: 16,
} as const;

export class OpmlParseError extends Error {
    constructor(message: string) {
        super(message);
        this.name = "OpmlParseError";
    }
}

/**
 * Rejects documents that declare entities or an internal DTD subset. That is the
 * only vector for XXE (external entities) and "billion laughs" (nested entity
 * expansion); OPML never needs either, so refusing outright is safer than
 * relying on a parser's entity handling. JSDOM never fetches external DTDs.
 */
export function assertSafeOpmlXml(xml: string): void {
    if (/<!ENTITY/i.test(xml) || /<!DOCTYPE[^>]*\[/i.test(xml)) {
        throw new OpmlParseError("OPML documents with entity declarations or an internal DTD subset are not accepted");
    }
    // Cheap pre-check so an outline flood is refused before the (slow) DOM parse.
    let outlines = 0;
    for (const _ of xml.matchAll(/<outline[\s/>]/g)) {
        if (++outlines > OPML_PARSE_LIMITS.maxOutlines) {
            throw new OpmlParseError(`OPML contains more than ${OPML_PARSE_LIMITS.maxOutlines} outlines`);
        }
    }
}

export interface OpmlOutline {
    text: string;
    title?: string;
    type?: string;
    xmlUrl?: string;
    htmlUrl?: string;
    description?: string;
    category?: string;
    extensions?: Record<string, string>;
    children?: OpmlOutline[];
}

/**
 * Parses an OPML string into a hierarchical list of outlines, preserving Scout Studio
 * extended attributes under `outline.extensions`.
 */
export async function parseOpml(xml: string): Promise<OpmlOutline[]> {
    const source = xml.charCodeAt(0) === 0xfeff ? xml.slice(1) : xml;
    assertSafeOpmlXml(source);
    const { JSDOM } = await import("jsdom");
    let document: Document;
    try {
        document = new JSDOM(source, { contentType: "text/xml" }).window.document;
    } catch (error) {
        throw new OpmlParseError(`Invalid OPML/XML document: ${error instanceof Error ? error.message : String(error)}`);
    }
    const body = document.querySelector("body");

    if (!body) return [];

    let outlineCount = 0;

    const parseOutline = (element: Element, depth: number): OpmlOutline => {
        if (depth > OPML_PARSE_LIMITS.maxDepth) throw new OpmlParseError(`OPML nesting deeper than ${OPML_PARSE_LIMITS.maxDepth} levels`);
        if (++outlineCount > OPML_PARSE_LIMITS.maxOutlines) throw new OpmlParseError(`OPML contains more than ${OPML_PARSE_LIMITS.maxOutlines} outlines`);

        // Every attribute in the FreshRSS extension namespace is kept (the prefix is
        // not significant, the namespace is). Unknown names are preserved verbatim so
        // the importer can report/preserve them instead of silently dropping them.
        const extensions: Record<string, string> = {};
        for (const attribute of Array.from(element.attributes)) {
            const inNamespace = attribute.namespaceURI === OPML_EXTENSION_NAMESPACE;
            const legacyPrefix = !attribute.namespaceURI && attribute.name.startsWith(`${OPML_EXTENSION_PREFIX}:`);
            if (!inNamespace && !legacyPrefix) continue;
            const name = inNamespace ? attribute.localName : attribute.name.slice(OPML_EXTENSION_PREFIX.length + 1);
            if (attribute.value !== "") extensions[name] = attribute.value;
        }

        const outline: OpmlOutline = {
            text: element.getAttribute("text") || element.getAttribute("title") || "Untitled",
            title: element.getAttribute("title") || undefined,
            type: element.getAttribute("type") || undefined,
            xmlUrl: element.getAttribute("xmlUrl") || undefined,
            htmlUrl: element.getAttribute("htmlUrl") || undefined,
            description: element.getAttribute("description") || undefined,
            category: element.getAttribute("category") || undefined,
            extensions: Object.keys(extensions).length ? extensions : undefined,
        };

        const children = Array.from(element.children).filter(el => el.tagName.toLowerCase() === "outline");
        if (children.length > 0) {
            outline.children = children.map((child) => parseOutline(child, depth + 1));
        }

        return outline;
    };

    return Array.from<Element>(body.children)
        .filter((el: Element) => el.tagName.toLowerCase() === "outline")
        .map((el) => parseOutline(el, 1));
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
    const httpOptions = parseJsonObject<FeedHttpOptions>(feed.httpOptions);
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
