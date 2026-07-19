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

// Declarations dropped outright regardless of value: these size an element
// independently of its container and are the recurring cause of mobile
// overflow from source-page inline styles.
const DROPPED_STYLE_PROPS = new Set(["width", "min-width"]);

// `position` values that let an element escape its container's normal flow
// entirely — meaningful on a live page's own layout, never inside our
// reader's scrollable excerpt. `fixed`/`sticky` position relative to the
// viewport (not any ancestor, so a plain `overflow: hidden` container does
// NOT clip them); `absolute` escapes to the nearest positioned ancestor,
// which inside sanitized article content is typically none, falling back to
// the same viewport-relative behavior. Reported case: a browser-rendered
// page (M7-T2 sidecar) carried a fixed-position image/lightbox element whose
// offset broke the reader's layout — see the "position" branch below.
const ESCAPING_POSITION_VALUES = new Set(["fixed", "sticky", "absolute"]);

/**
 * Strips layout-breaking declarations from an inline `style` attribute value
 * while preserving everything else (including `max-width`). Robust to
 * whitespace and casing, e.g. "Min-Width : 600px" or "POSITION:Fixed".
 */
export function stripLayoutBreakingStyles(styleValue: string): string {
    return styleValue
        .split(";")
        .map((decl) => decl.trim())
        .filter((decl) => {
            if (!decl) return false;
            const [rawProp, rawValue] = decl.split(":");
            const prop = rawProp?.trim().toLowerCase();
            if (!prop) return false;
            if (DROPPED_STYLE_PROPS.has(prop)) return false;
            if (prop === "position" && ESCAPING_POSITION_VALUES.has((rawValue || "").trim().toLowerCase())) {
                return false;
            }
            return true;
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
                data.attrValue = stripLayoutBreakingStyles(data.attrValue);
            }
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
