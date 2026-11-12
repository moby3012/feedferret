// Edge boilerplate trim for extracted article HTML (jsdom): HTML worker only
// (see lib/html-worker/tasks.ts). Split from lib/extraction-quality.ts so the
// parse-free quality gate can be used on the main thread.

import { JSDOM } from "jsdom";
import { LEAK_TEST } from "@/lib/extraction-quality";

// ---------------------------------------------------------------------------
// Edge boilerplate trim
// ---------------------------------------------------------------------------

// Only complete short UI labels, never substrings within prose.
const CTA_PATTERN = /^(?:newsletter|subscribe|abonnieren sie unseren newsletter|follow us|folgen sie|related articles|weitere artikel|mehr zum thema|lesen sie auch|auch interessant|you might also like|read more|recommended|empfohlen|startseite|zur startseite|anzeige|advertisement|sponsored|comments?|kommentare|sign up)[:!… ]*$/i;
const SHARE_PATTERN = /^(?:share(?: this| on| via)?|teilen(?: via)?|partager|compartir|condividi)\b/i;
// “Sitzung wird überprüft” is a generic bot-challenge label, not a site-specific rule.
const CHECK_PATTERN = /^(?:sitzung wird überprüft|checking your browser|vérification du navigateur|verificando (?:su navegador|tu navegador))[.…! ]*$/i;

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
    if (text.length < 200 && CHECK_PATTERN.test(text)) return true;
    if (LEAK_TEST.test(text)) return text.length < 400;
    const density = blockLinkDensity(el);
    const linkList = el.matches("ul, ol, nav") ||
        (el.querySelectorAll("a").length >= 2 && !/[.!?。]/.test(text));
    if (density > 0.5 && text.length < 1200 && linkList) return true;
    const shortLabel = text.length < 120 && text.split(/\s+/).length <= 8 && !/[.!?。]/.test(text);
    if (shortLabel && SHARE_PATTERN.test(text) && (density > 0.2 || !!el.querySelector("svg, button, ul, [role='list']"))) return true;
    if (text.length < 100 && CTA_PATTERN.test(text)) return true;
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
    let dom: JSDOM | undefined;
    try {
        dom = new JSDOM(`<body>${html}</body>`);
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
    } finally {
        dom?.window.close();
    }
}
