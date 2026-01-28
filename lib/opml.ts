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
 * Generates an OPML string from a list of feeds and categories.
 */
export function generateOpml(feeds: any[]): string {
    const header = `<?xml version="1.0" encoding="UTF-8"?>
<opml version="2.0">
  <head>
    <title>FeedFox Subscriptions</title>
    <dateCreated>${new Date().toUTCString()}</dateCreated>
  </head>
  <body>`;

    const footer = `
  </body>
</opml>`;

    // Simple flat list for now, can be hierarchical later
    const outlines = feeds.map(feed => {
        return `    <outline text="${escapeXml(feed.name)}" title="${escapeXml(feed.name)}" type="rss" xmlUrl="${escapeXml(feed.url)}" htmlUrl="${escapeXml(feed.url)}"/>`;
    }).join("\n");

    return header + "\n" + outlines + footer;
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
