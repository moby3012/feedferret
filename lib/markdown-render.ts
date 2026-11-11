// Shared server-side Markdown→HTML helper, backed by a lazy singleton
// MarkdownIt instance (mirrors the lazy-singleton pattern in
// lib/html-to-markdown.ts). Used to render Article.contentFormat ===
// "markdown" content back to HTML for API clients (Fever, v1 REST, ...)
// that only understand HTML.

import MarkdownIt from "markdown-it";
import taskLists from "markdown-it-task-lists";
import markdownItKatex from "@vscode/markdown-it-katex";
import hljs from "highlight.js";
import { sanitizeTrustedRendererHtml } from "@/lib/sanitize-html";

let markdownIt: MarkdownIt | null = null;

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

function highlightCode(code: string, lang: string): string {
  if (lang && hljs.getLanguage(lang)) {
    try {
      return hljs.highlight(code, { language: lang, ignoreIllegals: true }).value;
    } catch {
      // fall through to escaped, unhighlighted output below
    }
  }
  return escapeHtml(code);
}

function getMarkdownIt(): MarkdownIt {
  if (!markdownIt) {
    markdownIt = new MarkdownIt({
      html: false,
      linkify: true,
      typographer: true,
      // highlight.js's own convention is `class="hljs"` on the <code>
      // element (not <pre>) — matches what its theme stylesheets target.
      highlight: (code, lang) => `<pre><code class="hljs">${highlightCode(code, lang)}</code></pre>`,
    })
      // GFM task-list checkboxes (`- [x] done`) — otherwise render as literal
      // "[x] done" text, since plain markdown-it has no GFM extension for this.
      .use(taskLists, { enabled: false })
      // KaTeX math (`$inline$` / `$$block$$` / ```math fences), pre-rendered
      // to static HTML+MathML server-side — no client-side JS needed to
      // display formulas, only KaTeX's stylesheet for layout/fonts.
      // `trust: false` (no \htmlClass/\htmlStyle/\href) and size caps keep
      // attacker-written math (markdown articles come from feeds) from
      // producing huge or offset boxes; html:false keeps raw HTML out, which
      // is what makes this output safe for sanitizeTrustedRendererHtml().
      .use(markdownItKatex, { throwOnError: false, trust: false, maxSize: 10, maxExpand: 200 });

    // Lazy-load article images, same as the HTML-format article path.
    const defaultImageRule =
      markdownIt.renderer.rules.image ??
      ((tokens, idx, options, _env, self) => self.renderToken(tokens, idx, options));
    markdownIt.renderer.rules.image = (tokens, idx, options, env, self) => {
      tokens[idx].attrSet("loading", "lazy");
      return defaultImageRule(tokens, idx, options, env, self);
    };
  }
  return markdownIt;
}

/**
 * Renders a Markdown string to sanitized HTML, suitable for serving to
 * external API clients that expect article content as HTML.
 */
export async function renderMarkdownToHtml(markdown: string): Promise<string> {
  const rawHtml = getMarkdownIt().render(markdown);
  return sanitizeTrustedRendererHtml(rawHtml);
}
