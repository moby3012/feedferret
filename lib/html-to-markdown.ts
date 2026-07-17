// Shared server-side HTML→Markdown helper, backed by a lazy singleton
// TurndownService (same config as the client-side "Copy as Markdown" helper
// in components/article-reader.tsx — kept separate so this module can be
// imported from server-only code without pulling in that client component).

import TurndownService from "turndown";
import { gfm } from "turndown-plugin-gfm";

let turndownService: TurndownService | null = null;

function getTurndownService() {
  if (!turndownService) {
    turndownService = new TurndownService({ headingStyle: "atx", codeBlockStyle: "fenced" });
    turndownService.use(gfm);
  }
  return turndownService;
}

/**
 * Converts an HTML string to GitHub-flavored Markdown.
 */
export function htmlToMarkdown(html: string): string {
  return getTurndownService().turndown(html);
}
