// Generic lazy-loading image normalization, applied to a page's DOM BEFORE
// article extraction and sanitizing.
//
// Lazy-loading scripts never run in our extraction (jsdom, no scripts), so a
// page that ships `<img src="data:…placeholder" data-src="real.jpg">` would
// lose every image: extractors keep the placeholder (or drop the image as
// decorative) and the sanitizer then strips the `data-*` attributes. This
// promotes the real source into `src`/`srcset` using the conventions lazy
// loaders share, and falls back to the `<noscript>` copy pages ship for
// non-JS clients. No site lists — attribute conventions only.

// Common lazy-loader attribute names, in priority order.
const LAZY_SRC_ATTRS = [
    "data-src",
    "data-lazy-src",
    "data-original",
    "data-lazy",
    "data-url",
    "data-hi-res-src",
    "data-full-src",
    "data-orig-file",
    "data-actualsrc",
    "data-echo",
];
const LAZY_SRCSET_ATTRS = ["data-srcset", "data-lazy-srcset", "data-original-srcset"];

function isPlaceholderSrc(src: string | null): boolean {
    if (!src) return true;
    const value = src.trim();
    if (!value) return true;
    if (/^data:/i.test(value)) return true; // inline placeholder svg/gif
    if (/^about:blank$/i.test(value)) return true;
    // Classic 1x1 spacer / blank / placeholder file names.
    return /(?:^|\/)(?:blank|spacer|pixel|placeholder|transparent|lazy|loading|grey|gray)[\w-]*\.(?:gif|png|svg|jpe?g|webp)(?:[?#].*)?$/i.test(value);
}

function looksLikeImageUrl(value: string | null): value is string {
    if (!value) return false;
    const v = value.trim();
    if (!v || /^data:/i.test(v) || /^javascript:/i.test(v)) return false;
    return /^(?:https?:)?\/\//i.test(v) || v.startsWith("/") || /^[\w./-]+\.(?:jpe?g|png|gif|webp|avif|svg)(?:[?#].*)?$/i.test(v);
}

function absolutize(value: string, baseUrl: string | undefined): string {
    if (!baseUrl) return value;
    try {
        return new URL(value, baseUrl).toString();
    } catch {
        return value;
    }
}

function absolutizeSrcset(srcset: string, baseUrl: string | undefined): string {
    return srcset
        .split(",")
        .map((part) => {
            const trimmed = part.trim();
            if (!trimmed) return "";
            const [url, ...descriptor] = trimmed.split(/\s+/);
            if (!url || /^data:/i.test(url)) return "";
            return [absolutize(url, baseUrl), ...descriptor].join(" ");
        })
        .filter(Boolean)
        .join(", ");
}

/** Largest candidate from a srcset (by w/x descriptor), used when an <img> has no usable src at all. */
function bestFromSrcset(srcset: string): string | null {
    let best: { url: string; weight: number } | null = null;
    for (const part of srcset.split(",")) {
        const [url, descriptor] = part.trim().split(/\s+/);
        if (!url || /^data:/i.test(url)) continue;
        const match = descriptor?.match(/^(\d+(?:\.\d+)?)([wx])$/);
        const weight = match ? Number(match[1]) * (match[2] === "x" ? 1000 : 1) : 1;
        if (!best || weight > best.weight) best = { url, weight };
    }
    return best?.url ?? null;
}

function promoteLazyAttributes(el: Element, baseUrl: string | undefined) {
    for (const attr of LAZY_SRCSET_ATTRS) {
        const value = el.getAttribute(attr);
        if (value && value.trim()) {
            el.setAttribute("srcset", absolutizeSrcset(value, baseUrl));
            break;
        }
    }
    const currentSrcset = el.getAttribute("srcset");
    if (currentSrcset) {
        const cleaned = absolutizeSrcset(currentSrcset, baseUrl);
        if (cleaned) el.setAttribute("srcset", cleaned);
        else el.removeAttribute("srcset");
    }

    if (el.tagName === "SOURCE") return;

    if (isPlaceholderSrc(el.getAttribute("src"))) {
        let promoted: string | null = null;
        for (const attr of LAZY_SRC_ATTRS) {
            const value = el.getAttribute(attr);
            if (looksLikeImageUrl(value)) {
                promoted = value.trim();
                break;
            }
        }
        if (!promoted) {
            const srcset = el.getAttribute("srcset");
            if (srcset) promoted = bestFromSrcset(srcset);
        }
        if (promoted) el.setAttribute("src", absolutize(promoted, baseUrl));
    }
}

/** Parses the markup inside a <noscript> (stored as text by HTML parsers with scripting on). */
function noscriptImages(noscript: Element): Element[] {
    const direct = Array.from(noscript.querySelectorAll("img"));
    if (direct.length > 0) return direct;
    const raw = noscript.textContent ?? "";
    if (!/<img\b/i.test(raw)) return [];
    const template = noscript.ownerDocument.createElement("template");
    template.innerHTML = raw;
    return Array.from(template.content.querySelectorAll("img"));
}

/**
 * Rewrites lazy-loaded images in place: promotes `data-src`/`data-srcset` (and
 * the other common lazy attribute names) to `src`/`srcset`, absolutizes them,
 * and replaces placeholder images with their `<noscript>` fallback. Drops
 * images that still only have an inline placeholder after all of that, since
 * they would render as empty boxes. Never throws.
 */
export function normalizeLazyMedia(document: Document, baseUrl?: string): void {
    try {
        // 1. <noscript> fallbacks: a placeholder <img> right before a <noscript><img>
        //    is replaced by the real one; a lone noscript image is unwrapped.
        for (const noscript of Array.from(document.querySelectorAll("noscript"))) {
            const images = noscriptImages(noscript);
            if (images.length === 0) continue;
            const real = images.find((img) => looksLikeImageUrl(img.getAttribute("src")) || !!img.getAttribute("srcset"));
            if (!real) continue;
            const imported = document.importNode(real, true) as Element;
            let prev = noscript.previousElementSibling;
            // Some loaders wrap the placeholder: <span><img data-src></span><noscript>…
            if (prev && prev.tagName !== "IMG" && prev.querySelectorAll("img").length === 1) {
                prev = prev.querySelector("img");
            }
            if (prev && prev.tagName === "IMG") {
                const hasRealSrc = !isPlaceholderSrc(prev.getAttribute("src")) || LAZY_SRC_ATTRS.some((a) => looksLikeImageUrl(prev!.getAttribute(a)));
                if (!hasRealSrc) {
                    prev.replaceWith(imported);
                    noscript.remove();
                    continue;
                }
                // The visible image is (or will be) real: the noscript copy would duplicate it.
                noscript.remove();
                continue;
            }
            noscript.replaceWith(imported);
        }

        // 2. Promote lazy attributes on <img> and <picture><source>.
        for (const el of Array.from(document.querySelectorAll("img, picture source"))) {
            promoteLazyAttributes(el, baseUrl);
        }

        // 3. Absolutize remaining real srcs; drop images that are still placeholder-only.
        for (const img of Array.from(document.querySelectorAll("img"))) {
            const src = img.getAttribute("src");
            if (isPlaceholderSrc(src)) {
                const parentPicture = img.closest("picture");
                const hasSource = parentPicture?.querySelector("source[srcset]");
                if (!img.getAttribute("srcset") && !hasSource) img.remove();
                continue;
            }
            img.setAttribute("src", absolutize(src!.trim(), baseUrl));
            // Native lazy hint is irrelevant in the reader and some extractors treat it as decorative.
            if (img.getAttribute("loading") === "lazy") img.removeAttribute("loading");
        }
    } catch {
        // Normalization is best effort: extraction proceeds on the untouched DOM.
    }
}
