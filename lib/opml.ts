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

function getExtensionAttr(element: Element, name: string): string | undefined {
    return (
        element.getAttribute(`${OPML_EXTENSION_PREFIX}:${name}`) ||
        element.getAttributeNS(OPML_EXTENSION_NAMESPACE, name) ||
        undefined
    );
}

/**
 * Parses an OPML string into a hierarchical list of outlines, preserving Scout Studio
 * extended attributes under `outline.extensions`.
 */
export async function parseOpml(xml: string): Promise<OpmlOutline[]> {
    const { JSDOM } = await import("jsdom");
    const dom = new JSDOM(xml, { contentType: "text/xml" });
    const document = dom.window.document;
    const body = document.querySelector("body");

    if (!body) return [];

    const parseOutline = (element: Element): OpmlOutline => {
        const extensions: Record<string, string> = {};
        const extensionNames = [
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
            ...XPATH_ATTRS,
            ...JSON_ATTRS,
            ...HTTP_ATTRS,
        ];
        for (const name of extensionNames) {
            const value = getExtensionAttr(element, name);
            if (value !== undefined && value !== "") extensions[name] = value;
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
            outline.children = children.map(parseOutline);
        }

        return outline;
    };

    return Array.from<Element>(body.children)
        .filter((el: Element) => el.tagName.toLowerCase() === "outline")
        .map(parseOutline);
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

function escapeXml(unsafe: string): string {
    return unsafe.replace(/[<>&"']/g, (c) => {
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
