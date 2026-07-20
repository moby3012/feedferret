import type { ReactNode } from "react";

// Client-safe subset of lib/search.ts's tokenizer/field-grammar, used only to
// figure out which free-text terms in a query should be visually highlighted
// in search results. Deliberately does not import lib/search.ts (which pulls
// in the Prisma client via lib/db) — this only needs to mirror which tokens
// count as "free text" there, not the actual query-building.
const FIELD_PREFIXES = new Set([
  "author", "by", "intitle", "title", "intext", "text", "content",
  "inurl", "url", "link", "feed", "f", "category", "cat", "c",
  "label", "tag", "is", "status", "after", "since", "before", "until",
  "date", "pubdate",
]);

export function extractHighlightTerms(query: string): string[] {
  if (!query?.trim()) return [];

  const tokens: string[] = [];
  const re = /"([^"]+)"|'([^']+)'|(\S+)/g;
  let match: RegExpExecArray | null;
  while ((match = re.exec(query)) !== null) {
    tokens.push(match[1] || match[2] || match[3]);
  }

  const terms: string[] = [];
  for (const raw of tokens) {
    if (raw.toUpperCase() === "OR") continue;
    if (raw.startsWith("-") || raw.startsWith("!")) continue; // exclusion, not a match
    if (raw.startsWith("#")) continue; // label shorthand, not free text
    const [key, ...rest] = raw.split(":");
    if (rest.length > 0 && FIELD_PREFIXES.has(key.toLowerCase())) continue; // field-scoped
    const value = raw.trim();
    if (value.length >= 2) terms.push(value);
  }
  return terms;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// Wraps every case-insensitive occurrence of any term in <mark>. Operates on
// plain strings only (article title/excerpt are rendered as text, never
// dangerouslySetInnerHTML), so this never introduces an XSS surface.
export function highlightText(text: string, terms: string[]): ReactNode {
  if (!text || terms.length === 0) return text;

  const escaped = Array.from(new Set(terms.map((t) => t.trim()).filter(Boolean)))
    .sort((a, b) => b.length - a.length)
    .map(escapeRegExp);
  if (escaped.length === 0) return text;

  const re = new RegExp(`(${escaped.join("|")})`, "gi");
  const parts = text.split(re);
  if (parts.length <= 1) return text;

  return parts.map((part, i) =>
    i % 2 === 1 ? (
      <mark key={i} className="rounded-[2px] bg-accent/30 px-0.5 text-foreground">
        {part}
      </mark>
    ) : (
      part
    ),
  );
}
