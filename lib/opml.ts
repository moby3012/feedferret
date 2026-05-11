import {
    FRSS_NAMESPACE,
    HTTP_ATTRS,
    JSON_ATTRS,
    XPATH_ATTRS,
    FreshRssHttpOptions,
    FreshRssScraperConfig,
    normalizeSourceType,
    parseBooleanLike,
    parseIntLike,
    parseJsonObject,
} from "./freshrss-opml";

export interface OpmlOutline {
    text: string;
    title?: string;
    type?: string;
    xmlUrl?: string;
    htmlUrl?: string;
    description?: string;
    category?: string;
    frss?: Record<string, string>;
    children?: OpmlOutline[];
}

function getFrssAttr(element: Element, name: string): string | undefined {
    return (
        element.getAttribute(`frss:${name}`) ||
        element.getAttributeNS(FRSS_NAMESPACE, name) ||
        undefined
    );
}

/**
 * Parses an OPML string into a hierarchical list of outlines, preserving FreshRSS
 * extended attributes under `outline.frss`.
 */
export async function parseOpml(xml: string): Promise<OpmlOutline[]> {
    const { JSDOM } = await import("jsdom");
    const dom = new JSDOM(xml, { contentType: "text/xml" });
    const document = dom.window.document;
    const body = document.querySelector("body");

    if (!body) return [];

    const parseOutline = (element: Element): OpmlOutline => {
        const frss: Record<string, string> = {};
        const frssNames = [
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
        for (const name of frssNames) {
            const value = getFrssAttr(element, name);
            if (value !== undefined && value !== "") frss[name] = value;
        }

        const outline: OpmlOutline = {
            text: element.getAttribute("text") || element.getAttribute("title") || "Untitled",
            title: element.getAttribute("title") || undefined,
            type: element.getAttribute("type") || undefined,
            xmlUrl: element.getAttribute("xmlUrl") || undefined,
            htmlUrl: element.getAttribute("htmlUrl") || undefined,
            description: element.getAttribute("description") || undefined,
            category: element.getAttribute("category") || undefined,
            frss: Object.keys(frss).length ? frss : undefined,
        };

        const children = Array.from(element.children).filter(el => el.tagName.toLowerCase() === "outline");
        if (children.length > 0) {
            outline.children = children.map(parseOutline);
        }

        return outline;
    };

    return Array.from(body.children)
        .filter(el => el.tagName.toLowerCase() === "outline")
        .map(parseOutline);
}

function attr(name: string, value: unknown) {
    if (value === null || value === undefined || value === "") return "";
    return ` ${name}="${escapeXml(String(value))}"`;
}

function frssAttr(name: string, value: unknown) {
    return attr(`frss:${name}`, value);
}

function feedFrssAttributes(feed: any) {
    const scraper = parseJsonObject<FreshRssScraperConfig>(feed.scraperConfig);
    const httpOptions = parseJsonObject<FreshRssHttpOptions>(feed.httpOptions);
    let out = "";

    out += frssAttr("priority", feed.priority && feed.priority !== "main" ? feed.priority : undefined);
    out += frssAttr("unicityCriteria", feed.unicityCriteria && feed.unicityCriteria !== "id" ? feed.unicityCriteria : undefined);
    out += frssAttr("unicityCriteriaForced", feed.unicityCriteriaForced ? "true" : undefined);

    for (const name of XPATH_ATTRS) out += frssAttr(name, scraper.xpath?.[name]);
    for (const name of JSON_ATTRS) out += frssAttr(name, scraper.json?.[name]);
    out += frssAttr("xPathToJson", scraper.xPathToJson);

    out += frssAttr("filtersActionRead", feed.filtersActionRead);
    out += frssAttr("cssFullContent", feed.fullTextSelector);
    out += frssAttr("cssFullContentConditions", feed.fullTextConditions);
    out += frssAttr("cssContentFilter", feed.fullTextRemoveSelectors);

    for (const name of HTTP_ATTRS) out += frssAttr(name, httpOptions[name]);

    return out;
}

function feedOutline(feed: any, indent: string) {
    const type = normalizeSourceType(feed.sourceType || "rss");
    return `${indent}<outline text="${escapeXml(feed.name)}" title="${escapeXml(feed.name)}" type="${escapeXml(type)}" xmlUrl="${escapeXml(feed.url)}"${attr("htmlUrl", feed.htmlUrl || feed.url)}${attr("description", feed.description)}${feedFrssAttributes(feed)}/>`;
}

function categoryOutline(category: any, lines: string[], indent: string, childrenByParent: Map<string | null, any[]>, feedsByCategory: Map<string | null, any[]>) {
    const children = childrenByParent.get(category.id) ?? [];
    const feeds = feedsByCategory.get(category.id) ?? [];
    lines.push(`${indent}<outline text="${escapeXml(category.name)}" title="${escapeXml(category.name)}"${frssAttr("opmlUrl", category.opmlUrl)}>`);
    for (const child of children) categoryOutline(child, lines, `${indent}  `, childrenByParent, feedsByCategory);
    for (const feed of feeds) lines.push(feedOutline(feed, `${indent}  `));
    lines.push(`${indent}</outline>`);
}

/**
 * Generates an OPML string from feeds and optional categories. When categories
 * are provided, FreshRSS dynamic OPML categories and nested structure are kept.
 */
export function generateOpml(feeds: any[], categories: any[] = []): string {
    const header = `<?xml version="1.0" encoding="UTF-8"?>
<opml version="2.0" xmlns:frss="${FRSS_NAMESPACE}">
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
    const frss = outline.frss ?? {};
    const xpath: Record<string, string> = {};
    const json: Record<string, string> = {};
    for (const name of XPATH_ATTRS) if (frss[name]) xpath[name] = frss[name];
    for (const name of JSON_ATTRS) if (frss[name]) json[name] = frss[name];
    return {
        ...(Object.keys(xpath).length ? { xpath } : {}),
        ...(Object.keys(json).length ? { json } : {}),
        ...(frss.xPathToJson ? { xPathToJson: frss.xPathToJson } : {}),
    } satisfies FreshRssScraperConfig;
}

export function httpOptionsFromOutline(outline: OpmlOutline) {
    const frss = outline.frss ?? {};
    const http: FreshRssHttpOptions = {};
    for (const name of HTTP_ATTRS) {
        const value = frss[name];
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
