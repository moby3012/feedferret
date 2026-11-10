"use client";

import type { BriefingItem } from "@/lib/briefing/types";
import { cn } from "@/lib/utils";
import { CitationChip } from "./citation-chip";

/**
 * One briefing section ("Was passiert ist" …): `h4` overline + bullet list.
 * Item text is model output that was validated and sanitized server-side; it
 * is rendered as a plain React text node (never HTML, markdown or links).
 */
export function BriefingSection({
  id,
  heading,
  items,
  emphasis = false,
  indexOf,
  onOpen,
}: {
  id: string;
  heading: string;
  items: BriefingItem[];
  emphasis?: boolean;
  indexOf: (articleId: string) => number;
  onOpen: (articleId: string) => void;
}) {
  if (items.length === 0) return null;
  return (
    <div data-briefing-section={id} className="flex flex-col gap-1.5">
      <h4 className="text-footnote uppercase tracking-overline text-muted-foreground">{heading}</h4>
      <ul className="flex flex-col gap-1.5 ps-4 [list-style:disc] marker:text-muted-foreground">
        {items.map((item, i) => (
          <li key={`${i}:${item.text}`} data-briefing-item className={cn("break-words [overflow-wrap:anywhere]", emphasis ? "text-body" : "text-body-sm")}>
            {item.text}
            {item.citations.map((c) => (
              <CitationChip key={c.articleId} citation={c} index={indexOf(c.articleId)} onOpen={onOpen} />
            ))}
          </li>
        ))}
      </ul>
    </div>
  );
}
