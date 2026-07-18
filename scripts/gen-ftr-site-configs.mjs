// Regenerates lib/ftr-site-configs.ts from the upstream FiveFilters
// ftr-site-config repository (CC0-1.0 / public domain).
//
//   node scripts/gen-ftr-site-configs.mjs
//
// It fetches a curated shortlist of high-value hosts (major tech/news outlets
// FeedFerret users actually convert to RSS, incl. German-language ones), slims
// each rule file down to the directives our in-process applier understands, and
// writes the generated TypeScript module. To add a site, append its bare host
// to CURATED_HOSTS and re-run. Upstream: github.com/fivefilters/ftr-site-config.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const RAW_BASE = "https://raw.githubusercontent.com/fivefilters/ftr-site-config/master";

// Curated shortlist — regularly-requested outlets, weighted toward sites whose
// static HTML is awkward for the generic Defuddle/Readability heuristics.
const CURATED_HOSTS = [
  // US / UK tech & news
  "wired.com", "theverge.com", "arstechnica.com", "techcrunch.com", "engadget.com",
  "theguardian.com", "bbc.com", "bbc.co.uk", "nytimes.com", "washingtonpost.com",
  "reuters.com", "apnews.com", "cnn.com", "theatlantic.com", "newyorker.com",
  "vox.com", "slate.com", "wsj.com", "bloomberg.com", "ft.com", "economist.com",
  "gizmodo.com", "lifehacker.com", "mashable.com", "zdnet.com", "venturebeat.com",
  "thenextweb.com", "9to5mac.com", "macrumors.com", "androidpolice.com",
  "medium.com", "substack.com", "404media.co", "theregister.com",
  // German-language (primary test audience)
  "heise.de", "golem.de", "spiegel.de", "zeit.de", "sueddeutsche.de", "faz.net",
  "tagesschau.de", "t3n.de", "netzpolitik.org", "derstandard.at",
];

// Directives our in-process DOM applier consumes. Everything else (login,
// pagination, http headers, replace_string, test_url) is dropped: it's either
// irrelevant to in-process extraction or a fetch-time concern handled elsewhere.
const KEEP = /^(title|body|author|date|strip|strip_id_or_class)\s*:/i;

function slim(text) {
  const out = [];
  for (const line of text.split(/\r?\n/)) {
    const t = line.trim();
    if (!t || t.startsWith("#")) continue;
    if (KEEP.test(t)) out.push(t);
  }
  return out.join("\n");
}

async function fetchConfig(host) {
  const res = await fetch(`${RAW_BASE}/${host}.txt`);
  if (!res.ok) {
    console.warn(`  skip ${host} (HTTP ${res.status})`);
    return null;
  }
  return await res.text();
}

async function main() {
  const slimmed = {};
  for (const host of CURATED_HOSTS) {
    const text = await fetchConfig(host);
    if (!text) continue;
    const s = slim(text);
    if (s) {
      slimmed[host] = s;
      console.log(`  ok   ${host}`);
    }
  }

  const hosts = Object.keys(slimmed).sort();
  let ts = `// AUTO-GENERATED — do not edit by hand.
//
// Bundled subset of FiveFilters ftr-site-config per-site extraction rules.
// Source: https://github.com/fivefilters/ftr-site-config (CC0-1.0 / public domain).
// These are community-maintained XPath rules that tell the extractor exactly
// which DOM subtree holds an article's body/title/author/date on a given host,
// plus which chrome to strip. Used as the first extraction tier in
// lib/readability-extract.ts (ahead of Defuddle/Readability heuristics), and
// only for the directives our in-process applier understands
// (body/title/author/date/strip/strip_id_or_class); other FTR directives
// (login, pagination, http headers, string replacement) are intentionally
// omitted. Regenerate with scripts/gen-ftr-site-configs.mjs.
//
// Host keys are bare registrable hosts; matching (see lib/ftr-site-config.ts)
// also covers the "www." prefix and sub-domains.

export const FTR_SITE_CONFIGS: Record<string, string> = {
`;
  for (const host of hosts) {
    ts += `  ${JSON.stringify(host)}: ${JSON.stringify(slimmed[host])},\n`;
  }
  ts += `};\n`;

  const __dirname = path.dirname(fileURLToPath(import.meta.url));
  const outPath = path.join(__dirname, "..", "lib", "ftr-site-configs.ts");
  fs.writeFileSync(outPath, ts);
  console.log(`\nWrote ${hosts.length} configs to ${path.relative(process.cwd(), outPath)}`);
}

main();
