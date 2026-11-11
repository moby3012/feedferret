// Structured, token-bounded digest of a web page for AI prompts.
//
// The old prompt input was "the first 8 000 characters of the HTML", which on
// modern pages is mostly <head> (preloads, meta tags, utility-class soup): the
// model never saw the body, so it could neither spot the feed link nor the
// repeating item list. The digest instead gives the model what it needs to
// choose selectors, in a fixed budget and independent of where in the
// document things are:
//   - page facts (final URL, title, description, language, JSON-LD types),
//   - feed links (<link rel=alternate> and feed-looking anchors anywhere),
//   - the deterministic list heuristic's own candidates with sample items,
//   - headings, and
//   - a skeleton outline of the body (main content first): tag#id.classes,
//     short text / link samples, repeated siblings collapsed ("×24 more").
// Generic: no host rules, nothing site-specific.

import { JSDOM } from "jsdom";
import { suggestFeedCandidates } from "./page-feed-suggest";
import { redactUrlForPrompt } from "./prompt-url";

export const PAGE_DIGEST_MAX_CHARS = 12_000;

export type PageDigestOptions = {
  /** Total character budget of the digest (default PAGE_DIGEST_MAX_CHARS). */
  maxChars?: number;
  /** Run the list heuristic and include its candidates (default true). */
  includeCandidates?: boolean;
};

const SKIP_TAGS = new Set([
  "script", "style", "noscript", "template", "svg", "iframe", "link", "meta", "head", "br", "hr", "wbr",
  "path", "source", "track", "canvas", "object", "embed", "input", "select", "option", "textarea", "button",
]);
const TEXT_SAMPLE = 80;

function clip(text: string, max: number): string {
  const t = text.replace(/\s+/g, " ").trim();
  return t.length > max ? `${t.slice(0, max - 1)}…` : t;
}

/** Link sample for the prompt: credentials/userinfo/fragment redacted (lib/prompt-url). */
function shortHref(href: string, base: URL): string {
  try {
    const u = new URL(redactUrlForPrompt(href, base));
    const s = u.origin === base.origin ? `${u.pathname}${u.search}` : `${u.host}${u.pathname}${u.search}`;
    return clip(s, 90);
  } catch {
    return clip(redactUrlForPrompt(href), 90);
  }
}

function signature(el: Element): string {
  const tag = el.tagName.toLowerCase();
  const id = el.id && el.id.length <= 40 ? `#${el.id}` : "";
  const classes = [...el.classList].filter((c) => c.length <= 40).slice(0, 4).map((c) => `.${c}`).join("");
  return `${tag}${id}${classes}`;
}

/**
 * Sibling-grouping key: tag + first class (ids are often numbered and
 * utility-class tails vary per item). Many same-tag siblings with varying
 * classes (≥ 5) still group by tag alone.
 */
function shapeKey(el: Element, sameTagSiblings: number): string {
  const tag = el.tagName.toLowerCase();
  const first = el.classList[0];
  return sameTagSiblings >= 5 || !first ? tag : `${tag}.${first}`;
}

function ownText(el: Element): string {
  let text = "";
  for (const node of el.childNodes) if (node.nodeType === 3) text += node.textContent ?? "";
  return text.replace(/\s+/g, " ").trim();
}

function describe(el: Element, base: URL): string {
  const tag = el.tagName.toLowerCase();
  const parts: string[] = [];
  const text = ownText(el);
  if (tag === "a") {
    const label = clip(el.textContent ?? "", TEXT_SAMPLE);
    if (label) parts.push(`"${label}"`);
    const href = el.getAttribute("href");
    if (href) parts.push(`→ ${shortHref(href, base)}`);
    return parts.join(" ");
  }
  if (text) parts.push(`"${clip(text, TEXT_SAMPLE)}"`);
  if (tag === "time") {
    const dt = el.getAttribute("datetime");
    if (dt) parts.push(`datetime=${clip(dt, 40)}`);
  }
  if (tag === "img") {
    const alt = el.getAttribute("alt");
    const src = el.getAttribute("src") || el.getAttribute("data-src");
    if (alt) parts.push(`alt="${clip(alt, 60)}"`);
    if (src && !src.startsWith("data:")) parts.push(`src=${shortHref(src, base)}`);
  }
  return parts.join(" ");
}

class Budget {
  readonly lines: string[] = [];
  private used = 0;
  exhausted = false;
  constructor(private readonly max: number) {}
  get remaining() {
    return this.max - this.used;
  }
  /** Bypasses the budget for one short trailing marker (reserved in the constructor). */
  force(line: string) {
    this.lines.push(line);
  }
  push(line: string): boolean {
    if (this.exhausted) return false;
    if (this.used + line.length + 1 > this.max) {
      this.exhausted = true;
      return false;
    }
    this.lines.push(line);
    this.used += line.length + 1;
    return true;
  }
}

function elementChildren(el: Element): Element[] {
  return [...el.children].filter((c) => !SKIP_TAGS.has(c.tagName.toLowerCase()));
}

/** Text-free single-child wrapper chains are printed on one line: `div.a > div.b > ul.list`. */
function renderOutline(el: Element, depth: number, base: URL, out: Budget, skip: Element | null): void {
  if (out.exhausted || depth > 40) return;
  const chain = [signature(el)];
  let node = el;
  for (;;) {
    const kids = elementChildren(node);
    if (kids.length !== 1 || ownText(node) || node.tagName === "A" || kids[0] === skip) break;
    node = kids[0];
    chain.push(signature(node));
  }
  const detail = describe(node, base);
  if (!out.push(`${"  ".repeat(depth)}${chain.join(" > ")}${detail ? ` ${detail}` : ""}`)) return;
  if (node.tagName === "A") return;

  const kids = elementChildren(node);
  const tagCounts = new Map<string, number>();
  for (const k of kids) tagCounts.set(k.tagName, (tagCounts.get(k.tagName) ?? 0) + 1);
  const keyOf = (k: Element) => shapeKey(k, tagCounts.get(k.tagName) ?? 1);
  const counts = new Map<string, number>();
  for (const k of kids) counts.set(keyOf(k), (counts.get(keyOf(k)) ?? 0) + 1);
  const shown = new Map<string, number>();
  for (const kid of kids) {
    if (kid === skip) {
      out.push(`${"  ".repeat(depth + 1)}${signature(kid)} (main content, shown above)`);
      continue;
    }
    const key = keyOf(kid);
    const n = (shown.get(key) ?? 0) + 1;
    shown.set(key, n);
    const total = counts.get(key) ?? 1;
    if (n <= 2) {
      renderOutline(kid, depth + 1, base, out, skip);
    } else if (n === 3) {
      out.push(`${"  ".repeat(depth + 1)}… ×${total - 2} more ${shapeKey(kid, 0)}${key === kid.tagName.toLowerCase() && kid.classList[0] ? " (similar)" : ""}`);
    }
    if (out.exhausted) return;
  }
}

function feedLinks(document: Document, base: URL): string[] {
  const lines: string[] = [];
  const seen = new Set<string>();
  const add = (href: string | null, label: string) => {
    if (!href) return;
    let abs: string;
    try {
      abs = redactUrlForPrompt(new URL(href, base).toString());
    } catch {
      return;
    }
    if (seen.has(abs) || lines.length >= 8) return;
    seen.add(abs);
    lines.push(`- ${abs}${label ? ` (${clip(label, 60)})` : ""}`);
  };
  for (const el of document.querySelectorAll('link[rel~="alternate" i][href]')) {
    const type = el.getAttribute("type") ?? "";
    if (/rss|atom|feed\+json/i.test(type)) add(el.getAttribute("href"), el.getAttribute("title") ?? type);
  }
  for (const el of document.querySelectorAll("a[href]")) {
    const href = el.getAttribute("href") ?? "";
    const label = el.textContent?.trim() || el.getAttribute("aria-label") || el.getAttribute("title") || el.querySelector("img[alt]")?.getAttribute("alt") || "";
    if (/(?:rss|atom|feeds?)(?:[/?#.]|$)|\.(?:xml|rss)(?:[?#]|$)/i.test(href) || /\b(?:rss|atom)\b/i.test(label)) add(href, label);
  }
  return lines;
}

function jsonLdTypes(document: Document): string[] {
  const types = new Set<string>();
  for (const el of document.querySelectorAll('script[type="application/ld+json"]')) {
    try {
      const walk = (v: unknown) => {
        if (Array.isArray(v)) v.forEach(walk);
        else if (v && typeof v === "object") {
          const t = (v as Record<string, unknown>)["@type"];
          if (typeof t === "string") types.add(t);
          else if (Array.isArray(t)) t.forEach((x) => typeof x === "string" && types.add(x));
          const graph = (v as Record<string, unknown>)["@graph"];
          if (graph) walk(graph);
        }
      };
      walk(JSON.parse(el.textContent ?? ""));
    } catch {
      // ignore broken JSON-LD
    }
  }
  return [...types].slice(0, 10);
}

/**
 * Builds the digest. Never throws; an unparseable page yields the URL line
 * only. Deterministic for a given HTML + URL (golden-file friendly).
 */
export function buildPageDigest(html: string, url: string, opts: PageDigestOptions = {}): string {
  const maxChars = opts.maxChars ?? PAGE_DIGEST_MAX_CHARS;
  const out = new Budget(Math.max(0, maxChars - 24));
  let base: URL;
  try {
    base = new URL(url);
  } catch {
    base = new URL("https://invalid.example/");
  }
  out.push(`URL: ${redactUrlForPrompt(url)}`);

  let document: Document;
  try {
    document = new JSDOM(html).window.document;
  } catch {
    return out.lines.join("\n");
  }

  const meta = (sel: string) => document.querySelector(sel)?.getAttribute("content")?.trim() || "";
  const title = clip(document.querySelector("title")?.textContent ?? "", 150);
  if (title) out.push(`Title: ${title}`);
  const description = clip(meta('meta[name="description" i]') || meta('meta[property="og:description" i]'), 240);
  if (description) out.push(`Description: ${description}`);
  const lang = document.documentElement.getAttribute("lang");
  if (lang) out.push(`Language: ${clip(lang, 20)}`);
  const types = jsonLdTypes(document);
  if (types.length) out.push(`JSON-LD types: ${types.join(", ")}`);

  const feeds = feedLinks(document, base);
  out.push("");
  out.push("Feed links on the page:");
  if (feeds.length) feeds.forEach((l) => out.push(l));
  else out.push("- none");

  if (opts.includeCandidates !== false) {
    let candidates: ReturnType<typeof suggestFeedCandidates> = [];
    try {
      candidates = suggestFeedCandidates(html, url).slice(0, 3);
    } catch {
      candidates = [];
    }
    out.push("");
    out.push("Repeating lists found by the built-in heuristic (verify or improve; they may be wrong):");
    if (!candidates.length) out.push("- none");
    candidates.forEach((c, i) => {
      out.push(`${i + 1}. xPathItem ${c.config.xPathItem} — ${c.itemCount} items`);
      for (const [k, v] of Object.entries(c.config)) if (k !== "xPathItem" && v) out.push(`   ${k}: ${v}`);
      for (const a of c.previewArticles.slice(0, 3)) out.push(`   e.g. "${clip(a.title, 80)}" → ${shortHref(a.link, base)}`);
    });
  }

  const headings = [...document.querySelectorAll("h1, h2, h3")]
    .map((h) => `${h.tagName.toLowerCase()} ${clip(h.textContent ?? "", 100)}`)
    .filter((l) => l.length > 3)
    .slice(0, 30);
  if (headings.length) {
    out.push("");
    out.push("Headings:");
    headings.forEach((h) => out.push(`- ${h}`));
  }

  const body = document.body;
  if (body) {
    const main = body.querySelector("main, [role=main]") ?? body.querySelector("article") ?? null;
    out.push("");
    out.push("Body outline (tag#id.classes \"text sample\" → link; repeated siblings collapsed):");
    if (main && main !== body) {
      const path: string[] = [];
      for (let p: Element | null = main.parentElement; p && p !== body; p = p.parentElement) path.unshift(signature(p));
      out.push(`[main content] body${path.length ? ` > ${path.join(" > ")}` : ""}`);
      renderOutline(main, 1, base, out, null);
      if (!out.exhausted) {
        out.push("[rest of the page]");
        renderOutline(body, 1, base, out, main);
      }
    } else {
      renderOutline(body, 0, base, out, null);
    }
    if (out.exhausted) {
      out.force("… (outline truncated)");
    }
  }
  return out.lines.join("\n");
}
