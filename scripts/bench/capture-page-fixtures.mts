// Opt-in fixture capture for the selector quality gate tests (NOT a CI test).
//
// Fetches each requested benchmark site once through the app's own SSRF-safe
// page transport (same options as `fetchAndSuggestFeedCandidates`), trims the
// HTML down to the structure the selector heuristic and XPath engine read
// (tags, class/id, href/src/datetime/alt/title, text), and writes it to
// tests/fixtures/page-feed/<id>.html. Tests then run fully offline.
//
//   DATABASE_PROVIDER=sqlite DATABASE_URL=file:/tmp/ff-capture.db \
//     pnpm dlx tsx@4.23.15 scripts/bench/capture-page-fixtures.mts --live news-de-6 company-2
//
// Re-capturing changes expectations: review the diff and the test table in
// tests/lib/page-feed-quality.test.ts before committing new fixtures.

import { readFile, writeFile, mkdir } from "node:fs/promises";
import { JSDOM } from "jsdom";
import { stripStyleBlocks } from "../../lib/html-utils";

type Site = { id: string; url: string };

const KEEP_ATTRS = new Set(["class", "id", "href", "src", "datetime", "alt", "title", "lang"]);
const DROP_TAGS = ["script", "style", "template", "iframe", "link", "meta", "source", "object", "embed", "canvas", "video", "audio"];

export function trimHtml(html: string, url: string): string {
  const dom = new JSDOM(stripStyleBlocks(html), { url });
  const doc = dom.window.document;
  for (const tag of DROP_TAGS) for (const el of Array.from(doc.querySelectorAll(tag))) el.remove();
  // SVG icons are pure noise for the heuristic; keep an empty element so the layout signature survives.
  for (const svg of Array.from(doc.querySelectorAll("svg"))) svg.replaceChildren();
  const walker = doc.createTreeWalker(doc, dom.window.NodeFilter.SHOW_COMMENT);
  const comments: Node[] = [];
  while (walker.nextNode()) comments.push(walker.currentNode);
  for (const c of comments) c.parentNode?.removeChild(c);
  for (const el of Array.from(doc.querySelectorAll("*"))) {
    for (const attr of Array.from(el.attributes)) {
      if (!KEEP_ATTRS.has(attr.name)) el.removeAttribute(attr.name);
      else if (attr.name === "src" && attr.value.startsWith("data:")) el.setAttribute("src", "data:,");
    }
  }
  return "<!DOCTYPE html>\n" + doc.documentElement.outerHTML
    .replace(/[ \t]*\n[ \t]*/g, "\n")
    .replace(/[ \t]{2,}/g, " ")
    .replace(/\n{2,}/g, "\n");
}

async function main() {
  const args = process.argv.slice(2);
  if (!args.includes("--live")) throw new Error("Pass --live to authorize public network requests");
  if (process.env.CI) throw new Error("Refusing live capture in CI");
  const ids = args.filter((a) => !a.startsWith("--"));
  const sites: Site[] = JSON.parse(await readFile(new URL("./feed-everything.sites.json", import.meta.url), "utf8"));
  const { fetchTextWithSsrfProtection } = await import("../../lib/ssrf");
  const outDir = new URL("../../tests/fixtures/page-feed/", import.meta.url);
  await mkdir(outDir, { recursive: true });
  for (const id of ids) {
    const site = sites.find((s) => s.id === id);
    if (!site) { console.error(`${id}: unknown site id`); continue; }
    try {
      const html = await fetchTextWithSsrfProtection(site.url, {}, {
        allowInternal: false, context: "Page feed", impersonate: true,
        maxBytes: 2 * 1024 * 1024, maxRedirects: 5, timeoutMs: 12_000,
      });
      const trimmed = `<!-- captured ${new Date().toISOString().slice(0, 10)} from ${site.url} (trimmed) -->\n` + trimHtml(html, site.url);
      await writeFile(new URL(`${id}.html`, outDir), trimmed);
      console.log(`${id}: ${html.length} -> ${trimmed.length} bytes`);
    } catch (e) {
      console.error(`${id}: ${e instanceof Error ? e.message : String(e)}`);
    }
    await new Promise((r) => setTimeout(r, 750));
  }
  process.exit(0);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : "Capture failed");
  process.exitCode = 1;
});
