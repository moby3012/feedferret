// Small HTML helpers shared across the fetch/extract pipeline.

/**
 * Strips `<style>` blocks from raw page HTML before it is handed to jsdom.
 *
 * jsdom's CSS engine (cssstyle via @acemir/cssom) throws
 *   "Cannot create property 'border-width' on string 'var(--border-width, 1px)'"
 * while parsing a `<style>` block whose CSS uses a custom property inside a
 * `border` shorthand — e.g. `border: var(--border-width, 1px) solid …`. Many
 * modern sites (Wired/Condé Nast and others) do exactly this, and the throw
 * aborts the entire operation: article extraction returns "no content", and an
 * HTML+XPath feed sync fails outright (the "Error syncing feed … border-width"
 * seen in production logs).
 *
 * None of our jsdom uses (readability extraction, page→feed scraping, HTML
 * feed parsing) need stylesheets, so dropping `<style>` blocks is pure upside
 * and also speeds up parsing of large pages.
 */
export function stripStyleBlocks(html: string): string {
  return html.replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, "");
}
