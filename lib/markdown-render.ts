// Shared server-side Markdown→HTML helper, backed by a lazy singleton
// MarkdownIt instance (mirrors the lazy-singleton pattern in
// lib/html-to-markdown.ts). Used to render Article.contentFormat ===
// "markdown" content back to HTML for API clients (Fever, v1 REST, ...)
// that only understand HTML.

import MarkdownIt from "markdown-it";
import { getSanitizer } from "@/lib/sanitize-html";

let markdownIt: MarkdownIt | null = null;

function getMarkdownIt(): MarkdownIt {
  if (!markdownIt) {
    markdownIt = new MarkdownIt({ html: false, linkify: true, typographer: true });
  }
  return markdownIt;
}

/**
 * Renders a Markdown string to sanitized HTML, suitable for serving to
 * external API clients that expect article content as HTML.
 */
export async function renderMarkdownToHtml(markdown: string): Promise<string> {
  const rawHtml = getMarkdownIt().render(markdown);
  const DOMPurify = await getSanitizer();
  return DOMPurify.sanitize(rawHtml, { ADD_ATTR: ["target", "rel"] });
}
