import Parser from "rss-parser";

export interface OpmlOutline {
    text: string;
    title?: string;
    type?: string;
    xmlUrl?: string;
    htmlUrl?: string;
    children?: OpmlOutline[];
}

/**
 * Parses an OPML string into a hierarchical list of outlines.
 */
export async function parseOpml(xml: string): Promise<OpmlOutline[]> {
    const { JSDOM } = await import("jsdom");
    const dom = new JSDOM(xml, { contentType: "text/xml" });
    const document = dom.window.document;
    const body = document.querySelector("body");

    if (!body) return [];

    const parseOutline = (element: Element): OpmlOutline => {
        const outline: OpmlOutline = {
            text: element.getAttribute("text") || element.getAttribute("title") || "Untitled",
            title: element.getAttribute("title") || undefined,
            type: element.getAttribute("type") || undefined,
            xmlUrl: element.getAttribute("xmlUrl") || undefined,
            htmlUrl: element.getAttribute("htmlUrl") || undefined,
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

/**
 * Generates an OPML string from feeds, grouped by category.
 * Feeds must include a `category` relation object (or null).
 */
export function generateOpml(feeds: any[]): string {
    const header = `<?xml version="1.0" encoding="UTF-8"?>
<opml version="2.0">
  <head>
    <title>FeedFerret Subscriptions</title>
    <dateCreated>${new Date().toUTCString()}</dateCreated>
  </head>
  <body>`;

    const footer = `
  </body>
</opml>`;

    const feedOutline = (feed: any, indent: string) =>
        `${indent}<outline text="${escapeXml(feed.name)}" title="${escapeXml(feed.name)}" type="rss" xmlUrl="${escapeXml(feed.url)}" htmlUrl="${escapeXml(feed.url || "")}"/>`;

    // Group by category
    const byCategory = new Map<string | null, any[]>();
    for (const feed of feeds) {
        const key = feed.category?.name ?? null;
        if (!byCategory.has(key)) byCategory.set(key, []);
        byCategory.get(key)!.push(feed);
    }

    const lines: string[] = [];
    // Uncategorized first
    for (const feed of byCategory.get(null) ?? []) {
        lines.push(feedOutline(feed, "    "));
    }
    // Grouped
    for (const [catName, catFeeds] of byCategory) {
        if (catName === null) continue;
        lines.push(`    <outline text="${escapeXml(catName)}" title="${escapeXml(catName)}">`);
        for (const feed of catFeeds) {
            lines.push(feedOutline(feed, "      "));
        }
        lines.push(`    </outline>`);
    }

    return header + "\n" + lines.join("\n") + footer;
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
