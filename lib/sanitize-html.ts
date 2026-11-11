// Shared DOMPurify accessor for sanitizing untrusted article HTML.
//
// DOMPurify hooks are registered globally on the DOMPurify instance and apply
// to every subsequent `.sanitize()` call, regardless of the options passed at
// that call site. We use that to strip inline declarations that can blow out
// the reader's layout on narrow screens, without having to touch every call
// site's config.
//
// Only call sites that sanitize *article HTML content* should go through
// `getSanitizer()` here. Plain-text/excerpt call sites that pass
// `{ ALLOWED_TAGS: [] }` strip all tags anyway and can keep importing
// `isomorphic-dompurify` directly.

import type { UponSanitizeAttributeHookEvent } from "isomorphic-dompurify";

let hookRegistered = false;

// Inline `style` is filtered with a parsed ALLOWLIST (security review of N1 /
// #263): untrusted article and newsletter HTML must not be able to
//   - make the reader fetch anything (`background-image:url(…)`,
//     `list-style-image`, `image-set()`, `border-image`, CSS escapes such as
//     `\75 rl(` that spell `url(`), which is a tracking/IP leak, or
//   - escape the article box (`position:fixed`, `z-index`, `!important`
//     overrides of our prose CSS, offsets).
// Anything not explicitly allowed is dropped, declaration by declaration.

// Typography, alignment, box spacing and borders: safe in every context.
const ALLOWED_STYLE_PROPS = new Set([
    "font", "font-family", "font-size", "font-style", "font-weight", "font-variant", "font-variant-numeric",
    "font-feature-settings", "font-stretch", "line-height", "letter-spacing", "word-spacing",
    "text-align", "text-align-last", "text-decoration", "text-decoration-line", "text-decoration-style",
    "text-decoration-color", "text-decoration-thickness", "text-underline-offset", "text-transform",
    "text-indent", "text-overflow", "white-space", "word-break", "overflow-wrap", "word-wrap", "hyphens",
    "tab-size", "vertical-align", "direction", "unicode-bidi",
    "max-width", "max-height", "height", "min-height",
    "margin", "margin-top", "margin-right", "margin-bottom", "margin-left",
    "padding", "padding-top", "padding-right", "padding-bottom", "padding-left",
    "border", "border-top", "border-right", "border-bottom", "border-left",
    "border-width", "border-style", "border-color",
    "border-top-width", "border-right-width", "border-bottom-width", "border-left-width",
    "border-top-style", "border-right-style", "border-bottom-style", "border-left-style",
    "border-top-color", "border-right-color", "border-bottom-color", "border-left-color",
    "border-radius", "border-top-left-radius", "border-top-right-radius", "border-bottom-left-radius",
    "border-bottom-right-radius", "border-collapse", "border-spacing",
    "display", "float", "clear", "list-style-type", "list-style-position", "table-layout", "caption-side",
    "empty-cells", "overflow", "overflow-x", "overflow-y",
]);

// Sizing that blows out the mobile layout: only for our own KaTeX markup.
const KATEX_ONLY_STYLE_PROPS = new Set(["width", "min-width", "top", "position"]);

// Hardcoded text/background colors from the source page survive sanitization
// otherwise and outrank our prose/dark-mode CSS on specificity (an inline
// style always beats a class), so a source page's dark-gray-on-white text
// renders as near-black-on-dark in our reader's dark mode. Our own prose
// styling already handles light/dark for both; drop the source's opinion.
// (`background*` is not in the allowlist at all: it can also carry url().)

// CSS functions allowed in values; any other `name(` (url, image-set,
// expression, element, cross-fade, attr, env, …) drops the declaration.
const ALLOWED_CSS_FUNCTIONS = new Set(["rgb", "rgba", "hsl", "hsla", "calc", "min", "max", "clamp", "var"]);

// Escapes (`\75`), comments, markup, `!important` and legacy script vectors
// are never needed by legitimate inline typography.
const FORBIDDEN_VALUE_RE = /\\|\/\*|\*\/|[<>{}@]|!\s*important|javascript:|expression|behavior|-moz-binding/i;

function isSafeStyleValue(value: string): boolean {
    if (!value || FORBIDDEN_VALUE_RE.test(value)) return false;
    // Only plain printable ASCII-ish values (no control chars that some parsers skip).
    if (/[\u0000-\u001f\u007f]/.test(value)) return false;
    for (const match of value.matchAll(/([a-z0-9_-]*)\s*\(/gi)) {
        if (!ALLOWED_CSS_FUNCTIONS.has(match[1].toLowerCase())) return false;
    }
    return true;
}

/**
 * Filters an inline `style` attribute value through the allowlist above,
 * keeping the original spelling of every surviving declaration. Robust to
 * whitespace and casing, e.g. "Min-Width : 600px" or "POSITION:Fixed".
 *
 * `keepWidth` (our own KaTeX markup, see the hook below) additionally allows
 * `width`/`min-width`/`top` and `position: relative`, which KaTeX's
 * server-rendered math relies on for spacing/alignment.
 */
export function stripLayoutBreakingStyles(styleValue: string, keepWidth = false): string {
    return styleValue
        .split(";")
        .map((decl) => decl.trim())
        .filter((decl) => {
            if (!decl) return false;
            const colon = decl.indexOf(":");
            if (colon <= 0) return false;
            const prop = decl.slice(0, colon).trim().toLowerCase();
            const value = decl.slice(colon + 1).trim();
            if (!/^[a-z-]+$/.test(prop)) return false;
            if (!isSafeStyleValue(value)) return false;
            if (ALLOWED_STYLE_PROPS.has(prop)) return true;
            if (keepWidth && KATEX_ONLY_STYLE_PROPS.has(prop)) {
                return prop !== "position" || value.toLowerCase() === "relative";
            }
            return false;
        })
        .join("; ");
}


/**
 * Builds the sanitizer's JSDOM window and runs one sanitize call. isomorphic-dompurify creates its
 * window lazily, which costs ~300 ms of blocked event loop the first time any code sanitizes --
 * measured as the single longest stall of the first background sync tick (and of the first article
 * open). Called once at boot so that stall happens before traffic instead of during it.
 */
export async function warmSanitizer(): Promise<void> {
    const DOMPurify = await getSanitizer();
    DOMPurify.sanitize('<p style="width:1px">warm</p><a target="_blank" href="https://example.com">x</a>');
}

export async function getSanitizer() {
    const { default: DOMPurify } = await import("isomorphic-dompurify");

    if (!hookRegistered) {
        DOMPurify.addHook("uponSanitizeAttribute", (node, data: UponSanitizeAttributeHookEvent) => {
            const attrName = data.attrName.toLowerCase();
            // KaTeX (rendered server-side by lib/markdown-render.ts) depends
            // on inline width for math-symbol spacing/alignment — the normal
            // width-strip below is meant for untrusted scraped-page styles,
            // not our own generated markup, so exempt anything inside a
            // `.katex` subtree.
            const isKatex = typeof node.closest === "function" && !!node.closest(".katex");

            if (!isKatex && (attrName === "width" || attrName === "min-width")) {
                data.keepAttr = false;
                return;
            }

            // Legacy `background="https://…"` attribute: a remote fetch (tracking).
            if (attrName === "background") {
                data.keepAttr = false;
                return;
            }

            if (attrName === "style" && data.attrValue) {
                data.attrValue = stripLayoutBreakingStyles(data.attrValue, isKatex);
            }
        });

        // <style> elements (allowed by DOMPurify's default profile) would
        // restyle the whole app and can fetch url()s: never keep them.
        DOMPurify.addHook("uponSanitizeElement", (node, data) => {
            if (data.tagName === "style") node.parentNode?.removeChild(node);
        });

        // Reverse-tabnabbing protection: any element that keeps a `target`
        // attribute (e.g. links opened in a new tab) must also carry
        // rel="noopener noreferrer", regardless of what the source HTML set.
        DOMPurify.addHook("afterSanitizeAttributes", (node) => {
            if (node.tagName === "A" && node.getAttribute("target")) {
                node.setAttribute("rel", "noopener noreferrer");
            }
        });

        hookRegistered = true;
    }

    return DOMPurify;
}
