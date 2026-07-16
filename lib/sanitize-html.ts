// Shared DOMPurify accessor for sanitizing untrusted article HTML.
//
// DOMPurify hooks are registered globally on the DOMPurify instance and apply
// to every subsequent `.sanitize()` call, regardless of the options passed at
// that call site. We use that to strip inline `width` / `min-width` (which
// can blow out the reader layout on narrow screens) without having to touch
// every call site's config.
//
// Only call sites that sanitize *article HTML content* should go through
// `getSanitizer()` here. Plain-text/excerpt call sites that pass
// `{ ALLOWED_TAGS: [] }` strip all tags anyway and can keep importing
// `isomorphic-dompurify` directly.

import type { UponSanitizeAttributeHookEvent } from "isomorphic-dompurify";

let hookRegistered = false;

/**
 * Removes `width` and `min-width` declarations from an inline `style`
 * attribute value while preserving everything else (including `max-width`).
 * Robust to whitespace and casing, e.g. "Min-Width : 600px".
 */
export function stripWidthFromStyle(styleValue: string): string {
    return styleValue
        .split(";")
        .map((decl) => decl.trim())
        .filter((decl) => {
            if (!decl) return false;
            const prop = decl.split(":")[0]?.trim().toLowerCase();
            return prop !== "width" && prop !== "min-width";
        })
        .join("; ");
}

export async function getSanitizer() {
    const { default: DOMPurify } = await import("isomorphic-dompurify");

    if (!hookRegistered) {
        DOMPurify.addHook("uponSanitizeAttribute", (_node, data: UponSanitizeAttributeHookEvent) => {
            const attrName = data.attrName.toLowerCase();

            if (attrName === "width" || attrName === "min-width") {
                data.keepAttr = false;
                return;
            }

            if (attrName === "style" && data.attrValue) {
                data.attrValue = stripWidthFromStyle(data.attrValue);
            }
        });
        hookRegistered = true;
    }

    return DOMPurify;
}
