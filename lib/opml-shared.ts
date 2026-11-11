// Parse-free OPML pieces (limits, error type, the cheap pre-check, the
// outline shape), shared by the main-thread wrapper (lib/opml.ts) and the
// worker-side parser (lib/opml-parse-core.ts).

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

