import { describe, expect, it } from "vitest";
import { suggestFeedCandidatesDetailed } from "../../lib/page-feed-suggest";

// Synthetic pages (not the T1 fixtures), so the gate's thresholds are checked
// against shapes they were not tuned on: short slugs, short/CJK titles,
// conference/event paths, brand-led newsroom titles, aggregators, and
// placeholder-only lists in other languages.

type Item = { title: string; href: string; date?: string; text?: string };

function page(items: Item[], opts: { wrap?: string } = {}): string {
  const cards = items
    .map(
      (it) =>
        `<article class="card"><h2><a href="${it.href}">${it.title}</a></h2>${it.date ? `<time datetime="${it.date}">${it.date}</time>` : ""}${it.text ? `<p>${it.text}</p>` : ""}</article>`,
    )
    .join("");
  const list = `<div class="list">${cards}</div>`;
  return `<!doctype html><html><body><nav><a href="/">Home</a><a href="/about">About</a></nav><main>${opts.wrap ? opts.wrap.replace("{}", list) : list}</main></body></html>`;
}

function verdict(html: string, url: string) {
  const r = suggestFeedCandidatesDetailed(html, url);
  return { top: r.candidates[0], rejected: r.rejected };
}

const day = (i: number) => `2026-11-0${i + 1}`;

describe("synthetic probes: legitimate lists stay offered", () => {
  it("dated blog with short slugs and short titles (/blog/hello-world, /blog/regex, /blog/go)", () => {
    const slugs = ["hello-world", "regex", "go", "the-gap", "kurz", "rust"];
    const titles = ["Hello world", "Regex", "Go", "The gap", "Kurz", "Rust"];
    const { top } = verdict(page(slugs.map((s, i) => ({ title: titles[i], href: `/blog/${s}`, date: day(i) }))), "https://example.com/blog");
    expect(top?.quality.verdict).toBe("ok");
    // "Go" → /blog/go is the one title too short to trust without an entry-like link.
    expect(top.quality.plausibleItems).toBeGreaterThanOrEqual(5);
  });

  it("undated essays index with short slugs but real titles (/essays/the-gap)", () => {
    const items = ["the-gap", "taste", "cities", "default-alive", "wealth"].map((s) => ({
      title: `Essay on ${s.replace(/-/g, " ")} and what follows from it`,
      href: `/essays/${s}`,
    }));
    const { top } = verdict(page(items), "https://example.com/essays");
    expect(top?.quality.verdict).toBe("ok");
    expect(top.quality.notes).toEqual(["missingDates"]);
  });

  it("short German news slugs (/news/kurzer-beitrag) with teaser text", () => {
    const items = ["kurzer-beitrag", "neuer-plan", "wahl", "haushalt", "bahn"].map((s, i) => ({
      title: `Meldung ${i + 1}: ${s.replace(/-/g, " ")}`,
      href: `/news/${s}`,
      text: "Ein kurzer Anriss des Beitrags mit genug Text für eine Vorschau im Feed.",
    }));
    expect(verdict(page(items), "https://example.de/news").top?.quality.verdict).toBe("ok");
  });

  it("awesome-list of GitHub repos and Wikipedia articles on another site", () => {
    const items = [
      { title: "vercel/next.js", href: "https://github.com/vercel/next.js" },
      { title: "prisma/prisma", href: "https://github.com/prisma/prisma" },
      { title: "Lighthouse", href: "https://en.wikipedia.org/wiki/Lighthouse" },
      { title: "Fresnel lens", href: "https://en.wikipedia.org/wiki/Fresnel_lens" },
      { title: "rust-lang/rust", href: "https://github.com/rust-lang/rust" },
    ];
    const { top } = verdict(page(items), "https://awesome.example.org/");
    expect(top).toBeDefined();
    expect(top.quality.plausibleItems).toBe(5);
  });

  it("HN-like aggregator front page: many external sites is not a review reason", () => {
    const hosts = ["alpha.dev", "beta.io", "gamma.org", "delta.net", "epsilon.app", "zeta.blog"];
    const items = hosts.map((h, i) => ({ title: `Show item ${i + 1}: a long enough headline about ${h}`, href: `https://${h}/post/${i + 100}` }));
    const { top } = verdict(page(items), "https://news.example.com/");
    expect(top?.quality.verdict).toBe("ok");
    expect(top.quality.reasons).not.toContain("otherSites");
  });

  it("conference schedule (/sessions/…) and meetup joins (/join/…) are not login links", () => {
    const sessions = ["opening-keynote", "rust-in-production", "closing-panel", "lightning-talks", "workshop-ai"].map((s) => ({
      title: `Session: ${s.replace(/-/g, " ")}`,
      href: `/sessions/${s}`,
      date: "2026-11-20",
    }));
    expect(verdict(page(sessions), "https://conf.example.com/schedule").top?.quality.verdict).toBe("ok");
    const joins = ["weekly-meetup-berlin", "rust-hack-night", "design-crit-club", "board-games-sunday"].map((s) => ({
      title: `Join: ${s.replace(/-/g, " ")}`,
      href: `/join/${s}`,
      date: "2026-11-21",
    }));
    expect(verdict(page(joins), "https://meet.example.com/events").top?.quality.plausibleItems).toBe(4);
  });

  it("brand-led newsroom titles with dated links, and 'Introducing Stripe Tax'", () => {
    const acme = ["Acme opens Berlin", "Acme Q3 results", "Acme acquires Foo", "Acme joins OSI"].map((t, i) => ({
      title: t,
      href: `/newsroom/2024/0${i + 1}/${t.toLowerCase().replace(/ /g, "-")}`,
    }));
    expect(verdict(page(acme), "https://www.acme.com/newsroom").top?.quality.plausibleItems).toBe(4);
    const stripe = ["Introducing Stripe Tax", "Introducing Stripe Climate", "Introducing Payment Links", "Introducing Stripe Apps"].map((t) => ({
      title: t,
      href: `/blog/${t.toLowerCase().replace(/ /g, "-")}`,
      date: "2026-10-01",
    }));
    expect(verdict(page(stripe), "https://stripe.com/blog").top?.quality.plausibleItems).toBe(4);
  });

  it("CJK and very short Latin titles with entry links", () => {
    const cjk = ["新闻", "经济", "体育", "科技", "文化"].map((t, i) => ({ title: t, href: `/news/2026/11/${10000 + i}.html` }));
    expect(verdict(page(cjk), "https://zh.example.com/").top?.quality.plausibleItems).toBe(5);
    const short = ["Go", "C#", "R", "Io", "Zig"].map((t, i) => ({ title: t, href: `/2026/11/0${i + 1}/${t.toLowerCase().replace("#", "sharp")}-release` }));
    expect(verdict(page(short), "https://lang.example.com/").top?.quality.plausibleItems).toBe(5);
  });

  it("one stray promo card in a 20-item list does not trigger 'review'", () => {
    const items: Item[] = Array.from({ length: 19 }, (_, i) => ({ title: `Story number ${i + 1} about the harbour`, href: `/news/story-number-${i + 1}-harbour`, date: "2026-11-10" }));
    items.splice(7, 0, { title: "Read more", href: "/promo" });
    const { top } = verdict(page(items), "https://example.com/news");
    expect(top?.quality.verdict).toBe("ok");
  });
});

describe("synthetic probes: junk lists are still dropped", () => {
  it("French/Spanish/Italian 'read more' buttons only", () => {
    const items = ["Lire la suite", "Leer más", "Leggi di più", "Lire la suite", "En savoir plus"].map((t, i) => ({ title: t, href: `/a/${i}` }));
    const { top, rejected } = verdict(page(items), "https://example.fr/");
    expect(top).toBeUndefined();
    expect(rejected.count).toBeGreaterThan(0);
  });

  it("a menu of short labels leaving the entered section", () => {
    const items = ["Accessibility", "Education", "Environment", "Privacy", "Inclusion"].map((t) => ({ title: t, href: `/${t.toLowerCase()}/` }));
    const { top, rejected } = verdict(page(items), "https://example.com/careers/us/");
    expect(top).toBeUndefined();
    expect(rejected.reasons.navigationList).toBeGreaterThan(0);
  });

  it("an account/login block", () => {
    const items = [
      { title: "Log in to your workspace", href: "/login" },
      { title: "Create your free account", href: "/signup" },
      { title: "Reset your password here", href: "/password/reset" },
      { title: "Single sign-on for teams", href: "/sso" },
    ];
    expect(verdict(page(items), "https://app.example.com/").top).toBeUndefined();
  });
});

describe("work bounds", () => {
  it("a page with 200 repeating lists finishes well under 2 s", () => {
    const blocks = Array.from({ length: 200 }, (_, b) =>
      `<ul class="block-${b}">${Array.from({ length: 5 }, (_, i) => `<li class="row-${b}"><a href="/b${b}/entry-number-${i}-long-slug">Entry ${i} of block ${b} with a title</a><p>Some teaser text for this entry in block ${b}.</p></li>`).join("")}</ul>`,
    ).join("");
    const html = `<!doctype html><html><body><main>${blocks}</main></body></html>`;
    const started = Date.now();
    const r = suggestFeedCandidatesDetailed(html, "https://example.com/");
    expect(Date.now() - started).toBeLessThan(2000);
    expect(r.candidates.length).toBeGreaterThan(0);
    expect(r.candidates.length).toBeLessThanOrEqual(40);
  });
});
