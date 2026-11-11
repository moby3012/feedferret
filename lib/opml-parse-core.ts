// OPML parsing (pure): XML → outline tree with FreshRSS extension attributes.
// OPML is untrusted (uploads, REST/MCP, remote dynamic OPML categories) and
// jsdom builds the tree synchronously, so production code parses it only in
// the HTML worker pool via `parseOpml` in lib/opml.ts.

import { JSDOM } from "jsdom";
import { OPML_EXTENSION_NAMESPACE, OPML_EXTENSION_PREFIX } from "./feed-extraction";
import { OPML_PARSE_LIMITS, OpmlParseError, assertSafeOpmlXml, type OpmlOutline } from "./opml-shared";

/**
 * Parses an OPML string into a hierarchical list of outlines, preserving Scout Studio
 * extended attributes under `outline.extensions`.
 */
export function parseOpmlInProcess(xml: string): OpmlOutline[] {
    const source = xml.charCodeAt(0) === 0xfeff ? xml.slice(1) : xml;
    assertSafeOpmlXml(source);
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

