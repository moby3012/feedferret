// Lenient (HTML-mode) extraction of feed outlines from a remote catalog OPML
// (app/api/discovery/catalog/import). Fetched, so untrusted: runs only in the
// HTML worker pool (task `catalogOpmlEntries`). Pure.

import { JSDOM } from "jsdom";

export type CatalogOpmlEntry = { url: string; title: string; description?: string; parentTitle: string };

export function extractCatalogOpmlEntries(xml: string): CatalogOpmlEntry[] {
  // HTML mode: more lenient with malformed XML (some OPMLs have unclosed tags).
  const dom = new JSDOM(xml);
  try {
    const body = dom.window.document.querySelector("body");
    if (!body) return [];
    const entries: CatalogOpmlEntry[] = [];
    for (const element of body.querySelectorAll("outline")) {
      // HTML mode lowercases attributes, check both variants
      const xmlUrl = element.getAttribute("xmlurl") || element.getAttribute("xmlUrl");
      if (!xmlUrl) continue; // category outlines
      const parent = element.parentElement;
      entries.push({
        url: xmlUrl,
        title: element.getAttribute("title") || element.getAttribute("text") || "",
        description: element.getAttribute("description") || undefined,
        parentTitle: parent?.getAttribute("title") || parent?.getAttribute("text") || "",
      });
    }
    return entries;
  } finally {
    dom.window.close();
  }
}
