// Newsletter HTML hygiene: tracking-param / tracking-pixel removal, the jsdom
// pre-sanitize pass and the shared DOMPurify pipeline, plus link collection.
// Mail HTML is attacker-controlled and parsed with jsdom, so production code
// runs `newsletterBody` only in the HTML worker pool (lib/html-worker); this
// module is pure (no I/O, no DB).

import { JSDOM } from "jsdom";
import { getSanitizer } from "./sanitize-html";
import { MAX_HTML_CHARS, MAX_TEXT_CHARS, isTrackingImage, stripTrackingParams, type InlineImage, type LinkInfo } from "./newsletter-hygiene";

export type { InlineImage, LinkInfo } from "./newsletter-hygiene";

/** Inline (`cid:`) raster images become data: URIs up to these caps; others are dropped. */
const MAX_INLINE_IMAGE_BYTES = 512 * 1024;
const MAX_INLINE_TOTAL_BYTES = 2 * 1024 * 1024;

const HIDDEN_STYLE_RE = /(?:^|;)\s*(?:display\s*:\s*none|visibility\s*:\s*hidden|mso-hide\s*:\s*all)/i;
const DROP_TAGS = "script, style, link, meta, title, head, template, noscript, form, input, button, textarea, select, iframe, frame, frameset, object, embed, svg, math, base";


/**
 * Pre-sanitize pass on the raw newsletter HTML (jsdom without scripts or
 * resource loading), then the shared DOMPurify pipeline. Returns safe HTML.
 */
export async function sanitizeNewsletterHtml(html: string, inlineImages: Map<string, InlineImage> = new Map()): Promise<string> {
  const dom = new JSDOM(html.slice(0, MAX_HTML_CHARS));
  const doc = dom.window.document;
  try {
    doc.querySelectorAll(DROP_TAGS).forEach((el) => el.remove());
    doc.querySelectorAll("[hidden], [style]").forEach((el) => {
      if (el.hasAttribute("hidden") || HIDDEN_STYLE_RE.test(el.getAttribute("style") ?? "")) el.remove();
    });

    let inlineBudget = MAX_INLINE_TOTAL_BYTES;
    doc.querySelectorAll("img").forEach((img) => {
      const src = (img.getAttribute("src") ?? "").trim();
      if (/^cid:/i.test(src)) {
        let cid: string;
        try {
          cid = decodeURIComponent(src.slice(4));
        } catch {
          img.remove(); // malformed percent-encoding (`cid:%`)
          return;
        }
        const image = inlineImages.get(cid.replace(/^<|>$/g, "").trim().toLowerCase());
        if (!image || image.bytes > MAX_INLINE_IMAGE_BYTES || image.bytes > inlineBudget) {
          img.remove();
          return;
        }
        inlineBudget -= image.bytes;
        img.setAttribute("src", `data:${image.mimeType};base64,${image.base64}`);
        img.removeAttribute("srcset");
        return;
      }
      // Only http(s) images from the mail itself; foreign data:/javascript: etc. go.
      if (!/^https?:\/\//i.test(src)) {
        img.remove();
        return;
      }
      if (isTrackingImage({ src, width: img.getAttribute("width"), height: img.getAttribute("height"), style: img.getAttribute("style") })) {
        img.remove();
      }
    });

    doc.querySelectorAll("a[href]").forEach((a) => {
      const href = a.getAttribute("href") ?? "";
      const cleaned = stripTrackingParams(href.trim());
      if (cleaned !== href) a.setAttribute("href", cleaned);
    });

    // Newsletter layout tables: drop fixed pixel widths/bgcolor attributes the
    // global sanitizer hook does not cover (it handles `width` + inline style).
    doc.querySelectorAll("[bgcolor], [background]").forEach((el) => {
      el.removeAttribute("bgcolor");
      el.removeAttribute("background");
    });

    const body = doc.body?.innerHTML ?? "";
    const DOMPurify = await getSanitizer();
    return DOMPurify.sanitize(body, { FORBID_TAGS: ["style", "form", "input", "button", "textarea", "select", "svg", "math"], FORBID_ATTR: ["srcset"] }).trim();
  } finally {
    dom.window.close();
  }
}


export function collectLinks(html: string | undefined, text: string | undefined): LinkInfo[] {
  const links: LinkInfo[] = [];
  if (html) {
    const dom = new JSDOM(html.slice(0, MAX_HTML_CHARS));
    try {
      dom.window.document.querySelectorAll("a[href]").forEach((a) => {
        const href = (a.getAttribute("href") ?? "").trim();
        if (/^https:\/\//i.test(href)) links.push({ href, text: (a.textContent ?? "").replace(/\s+/g, " ").trim().slice(0, 200) });
      });
    } finally {
      dom.window.close();
    }
  } else if (text) {
    for (const m of text.slice(0, MAX_TEXT_CHARS).matchAll(/https:\/\/[^\s<>"']+/g)) links.push({ href: m[0], text: "" });
  }
  return links;
}

export type NewsletterBodyInput = {
  /** Mail HTML (already size/depth guarded by the caller), or null for text-only mails. */
  html: string | null;
  text: string | null;
  /** Text-only mails: the caller's textToHtml() rendering, sanitized here. */
  fallbackHtml: string | null;
  inlineImages: InlineImage[];
};

/** Sanitized body + collected https links of one newsletter mail. */
export async function buildNewsletterBody(input: NewsletterBodyInput): Promise<{ content: string; links: LinkInfo[] }> {
  const links = collectLinks(input.html ?? undefined, input.text ?? undefined);
  const images = new Map(input.inlineImages.map((image) => [image.contentId, image]));
  const content = input.html
    ? await sanitizeNewsletterHtml(input.html, images)
    : await sanitizeNewsletterHtml(input.fallbackHtml ?? "");
  return { content, links };
}
