// Edge boilerplate trim for extracted article HTML (jsdom): HTML worker only
// (see lib/html-worker/tasks.ts). Split from lib/extraction-quality.ts so the
// parse-free quality gate can be used on the main thread.

import { JSDOM } from "jsdom";
import { LEAK_TEST } from "@/lib/extraction-quality";

// ---------------------------------------------------------------------------
// Edge boilerplate trim
// ---------------------------------------------------------------------------

const CTA_PATTERN =
    /newsletter|subscribe|abonn|follow us|folgen sie|share (?:this|on)|teilen|related|weitere artikel|mehr zum thema|lesen sie auch|auch interessant|das könnte (?:dich|sie) (?:auch )?interessieren|you might also like|more from|read more|recommended|empfohlen|startseite|zur startseite|anzeige|advertisement|sponsored|comments?|kommentare|join (?:the|our) community|sign up|melde dich/i;

function blockText(el: Element): string {
    return (el.textContent ?? "").replace(/\s+/g, " ").trim();
}

function blockLinkDensity(el: Element): number {
    const text = blockText(el).length;
    if (text === 0) return 0;
    let links = 0;
    for (const a of Array.from(el.querySelectorAll("a"))) links += blockText(a).length;
    return links / text;
}

function isEdgeBoilerplate(el: Element): boolean {
    const tag = el.tagName;
    if (tag === "IMG" || tag === "PICTURE" || tag === "FIGURE" || tag === "VIDEO" || tag === "TABLE" || tag === "PRE") return false;
    const text = blockText(el);
    if (text.length === 0) return !el.querySelector("img, picture, video, iframe, svg");
    if (LEAK_TEST.test(text)) return text.length < 400;
    const density = blockLinkDensity(el);
    if (density > 0.5 && text.length < 1200) return true; // link lists, breadcrumbs, tag clouds
    if (text.length < 200 && CTA_PATTERN.test(text)) return true; // short CTA / "Anzeige" / "Startseite"
    return false;
}

const WRAPPER_TAGS = new Set(["DIV", "SECTION", "ARTICLE", "MAIN", "HEADER", "FOOTER", "ASIDE"]);

/**
 * Removes link lists, CTAs, script leaks and empty wrappers from the start and
 * end of an extracted article (the typical "Related articles" / "Share" /
 * "Subscribe" tail and breadcrumb head that extractors keep). Only edges are
 * touched — descending into wrapper elements along the first/last child — never
 * the body, and never more than a third of the text.
 */
export function trimEdgeBoilerplate(html: string): string {
    try {
        const dom = new JSDOM(`<body>${html}</body>`);
        const body = dom.window.document.body;
        const totalText = blockText(body).length;
        if (totalText === 0) return html;
        const budget = { left: Math.floor(totalText / 3), removed: 0 };

        const tryRemove = (el: Element): boolean => {
            if (!isEdgeBoilerplate(el)) return false;
            const len = blockText(el).length;
            if (len > budget.left) return false;
            budget.left -= len;
            budget.removed++;
            el.remove();
            return true;
        };

        const trimEdge = (container: Element, fromEnd: boolean, depth: number) => {
            if (depth > 12) return;
            for (;;) {
                const edge = fromEnd ? container.lastElementChild : container.firstElementChild;
                if (!edge) return;
                // Never strip a leading heading that has no links (the article title).
                if (!fromEnd && /^H[1-6]$/.test(edge.tagName) && blockLinkDensity(edge) === 0) return;
                // Keep at least one block in every container we descend into.
                if (container !== body && container.children.length === 1 && !WRAPPER_TAGS.has(edge.tagName)) return;
                if (tryRemove(edge)) continue;
                if (WRAPPER_TAGS.has(edge.tagName) && edge.children.length > 0) trimEdge(edge, fromEnd, depth + 1);
                return;
            }
        };

        trimEdge(body, true, 0);
        trimEdge(body, false, 0);
        return budget.removed > 0 ? body.innerHTML : html;
    } catch {
        return html;
    }
}
