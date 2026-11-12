// Parse-free extraction result types and helpers, shared by the worker-side
// extraction ensemble (lib/readability-core.ts) and the main-thread fetch +
// escalation wrapper (lib/readability-extract.ts).

import type { ExtractionQuality } from "@/lib/extraction-quality";
import { stripTags } from "@/lib/linear-text";

export type ExtractionResult = {
  html: string | null; // sanitized, cleaned article HTML (null if extraction failed)
  markdown: string | null; // htmlToMarkdown(html) (null if failed)
  title: string | null;
  byline: string | null;
  excerpt: string | null;
  wordCount: number;
  extractedBy: "selector" | "ftr" | "defuddle" | "readability" | "extractus" | "jsonld" | "ai" | "hosted" | "none";
  // Generic quality assessment of `html` (lib/extraction-quality.ts); null when nothing was extracted.
  quality: ExtractionQuality | null;
  // Set by fetchAndExtractReadable when an escalation tier would have run but
  // its per-sync budget was spent — the outcome is "not tried yet", not final.
  budgetSkipped?: boolean;
  // Set by the worker-backed extractReadableContent when the page could not be
  // parsed in budget (`too_complex`: timeout / worker out of memory) or the
  // HTML worker pool was saturated (`busy`, retry later) or cannot run at all
  // (`unavailable`: worker bundle missing — fail closed, never parsed inline).
  parseAborted?: "too_complex" | "busy" | "unavailable";
};

export function countWords(html: string): number {
  const text = stripTags(html)
    .replace(/\s+/g, " ")
    .trim();
  return text ? text.split(" ").length : 0;
}
