import { describe, expect, it } from "vitest";
import { JSDOM } from "jsdom";
import { assessExtraction, decideFullText, isBetterCandidate } from "@/lib/extraction-quality";
import { trimEdgeBoilerplate } from "@/lib/extraction-trim-core";
import { normalizeLazyMedia } from "@/lib/lazy-media";

const sentence = (n: number) =>
  `Sentence number ${n} explains another aspect of the city's new district heating plan in plain and specific detail.`;
const article = (count: number) => Array.from({ length: count }, (_, i) => `<p>${sentence(i)} ${sentence(i + 100)}</p>`).join("");

describe("assessExtraction", () => {
  it("rates a real article as good", () => {
    const q = assessExtraction(article(8));
    expect(q.verdict).toBe("good");
    expect(q.paragraphs).toBe(8);
    expect(q.linkDensity).toBe(0);
  });

  it("flags empty and thin content", () => {
    expect(assessExtraction("").verdict).toBe("empty");
    expect(assessExtraction(null).verdict).toBe("empty");
    expect(assessExtraction("<p>Short teaser only.</p>").verdict).toBe("thin");
  });

  it("detects a consent wall (multilingual lexicon, short text)", () => {
    const de = assessExtraction(
      "<p>Wir verwenden Cookies und übermitteln Daten an Drittanbieter. Mit Klick auf Alle akzeptieren erteilen Sie Ihre Einwilligung; personalisierte Anzeigen und IP-Adressen werden verarbeitet. Ihre Datenschutzeinstellungen können Sie jederzeit ändern.</p>",
    );
    expect(de).toMatchObject({ verdict: "wall", reason: "consent_wall" });
    const en = assessExtraction(
      "<p>We and our vendors use cookies to store and access information on a device. Accept all to consent to personalised ads and content; you can change your privacy settings at any time.</p>",
    );
    expect(en.verdict).toBe("wall");
  });

  it("detects a paywall stub and a bot check", () => {
    expect(
      assessExtraction("<p>The first paragraph of the story.</p><p>This story is for members only. Sign in to continue reading. Already a member?</p>").verdict,
    ).toBe("wall");
    expect(assessExtraction("<p>Please enable JavaScript and complete the captcha to continue.</p>").reason).toBe("bot_wall");
  });

  it("does not call a long article that merely mentions cookies a wall", () => {
    const html = `<p>Browsers are phasing out third-party cookies, and consent banners keep changing.</p>${article(12)}`;
    expect(assessExtraction(html).verdict).toBe("good");
  });

  it("flags link lists as boilerplate", () => {
    const html = `<ul>${Array.from({ length: 30 }, (_, i) => `<li><a href="/a/${i}">Related story headline number ${i}</a></li>`).join("")}</ul>`;
    expect(assessExtraction(html)).toMatchObject({ verdict: "boilerplate", reason: "link_list" });
  });

  it("counts script/state leaks and penalises the score", () => {
    const clean = assessExtraction(article(5));
    const leaky = assessExtraction(`${article(5)}<p>showPaywall: false isSubscriber: false isPaid: false</p>`);
    expect(leaky.leakSignals).toBe(3);
    expect(leaky.score).toBeLessThan(clean.score);
  });

  it("orders candidates by verdict first, then score", () => {
    const good = assessExtraction(article(4));
    const longWall = assessExtraction(
      `<p>${"Cookies Drittanbieter Einwilligung alle akzeptieren personalisierte Anzeigen. ".repeat(20)}</p>`,
    );
    expect(isBetterCandidate(good, longWall)).toBe(true);
    expect(isBetterCandidate(assessExtraction(article(8)), good)).toBe(true);
    expect(isBetterCandidate(good, null)).toBe(true);
  });
});

describe("decideFullText", () => {
  it("accepts a good article that is clearly longer than the feed teaser", () => {
    expect(decideFullText(assessExtraction(article(8)), "<p>Short teaser.</p>")).toEqual({ accept: true, reason: "ok" });
  });

  it("rejects a page that is no better than a rich feed item (never replaces it)", () => {
    expect(decideFullText(assessExtraction(article(4)), article(10))).toEqual({ accept: false, reason: "teaser" });
    // Same length as the feed (teaser re-rendered on the page)
    expect(decideFullText(assessExtraction(article(4)), article(4)).accept).toBe(false);
  });

  it("rejects walls, thin and empty results with their reason", () => {
    expect(decideFullText(assessExtraction("<p>Please enable JavaScript.</p>"), "")).toEqual({ accept: false, reason: "bot_wall" });
    expect(decideFullText(assessExtraction("<p>tiny</p>"), "")).toEqual({ accept: false, reason: "thin" });
    expect(decideFullText(null, "")).toEqual({ accept: false, reason: "empty" });
  });

  it("manual mode only needs a good result longer than the current content", () => {
    expect(decideFullText(assessExtraction(article(5)), article(4), "manual").accept).toBe(true);
    expect(decideFullText(assessExtraction(article(4)), article(5), "manual")).toEqual({ accept: false, reason: "not_longer" });
  });
});

describe("trimEdgeBoilerplate", () => {
  it("removes related-link lists, CTAs and state leaks at the end, nested in wrappers", () => {
    const html = `<article><div>${article(6)}<p>Abonnieren Sie unseren Newsletter</p><ul>${Array.from({ length: 6 }, (_, i) => `<li><a href="/r/${i}">Weitere Artikel ${i}</a></li>`).join("")}</ul><dl><div><dt>showPaywall:</dt><dd>false</dd></div></dl></div></article>`;
    const trimmed = trimEdgeBoilerplate(html);
    expect(trimmed).toContain(sentence(5));
    expect(trimmed).not.toContain("Weitere Artikel 3");
    expect(trimmed).not.toContain("showPaywall");
    expect(trimmed).not.toContain("Newsletter");
  });

  it("removes a breadcrumb head but keeps the title heading", () => {
    const html = `<div><p><a href="/">Home</a> › <a href="/tech">Tech</a></p><h1>Title</h1>${article(5)}</div>`;
    const trimmed = trimEdgeBoilerplate(html);
    expect(trimmed).not.toContain("›");
    expect(trimmed).toContain("<h1>Title</h1>");
  });

  it("never removes the body and leaves clean articles untouched", () => {
    const html = article(5);
    expect(trimEdgeBoilerplate(html)).toBe(html);
    const linkHeavyArticle = `<p><a href="/a">Everything</a> <a href="/b">is</a> <a href="/c">links</a></p>`;
    expect(trimEdgeBoilerplate(linkHeavyArticle)).toBe(linkHeavyArticle);
  });
});

describe("normalizeLazyMedia", () => {
  const run = (body: string, base = "https://site.example/post/1") => {
    const dom = new JSDOM(`<body>${body}</body>`, { url: base });
    normalizeLazyMedia(dom.window.document, base);
    return dom.window.document.body.innerHTML;
  };

  it("promotes data-src over an inline placeholder and absolutizes it", () => {
    const out = run(`<img src="data:image/svg+xml,%3Csvg%3E%3C/svg%3E" data-src="/img/a.jpg" alt="a">`);
    expect(out).toContain('src="https://site.example/img/a.jpg"');
    expect(out).not.toContain("data:image");
  });

  it("promotes data-srcset (largest candidate as src when there is none)", () => {
    const out = run(`<img src="/blank.gif" data-srcset="/s.jpg 480w, /l.jpg 1200w">`);
    expect(out).toContain('srcset="https://site.example/s.jpg 480w, https://site.example/l.jpg 1200w"');
    expect(out).toContain('src="https://site.example/l.jpg"');
  });

  it("uses the <noscript> fallback for a placeholder image", () => {
    const out = run(`<img class="lazy" src="data:image/gif;base64,R0lGOD"><noscript><img src="https://cdn.example/real.png" alt="r"></noscript>`);
    expect(out).toContain('src="https://cdn.example/real.png"');
    expect(out).not.toContain("noscript");
    expect(out.match(/<img/g)).toHaveLength(1);
  });

  it("drops a noscript duplicate when the visible image is real", () => {
    const out = run(`<img src="https://cdn.example/a.png"><noscript><img src="https://cdn.example/a.png"></noscript>`);
    expect(out.match(/<img/g)).toHaveLength(1);
  });

  it("handles <picture><source data-srcset> and removes placeholder-only images", () => {
    const out = run(`<picture><source data-srcset="https://cdn.example/t.webp 1x"><img data-src="https://cdn.example/t.jpg"></picture><img src="data:image/gif;base64,AAAA">`);
    expect(out).toContain(' srcset="https://cdn.example/t.webp 1x"');
    expect(out).toContain('src="https://cdn.example/t.jpg"');
    expect(out.match(/<img/g)).toHaveLength(1);
  });

  it("keeps only http(s)/relative srcset candidates", () => {
    const out = run(`<img src="/blank.gif" data-srcset="javascript:alert(1) 1x, data:image/png;base64,AA 2x, /ok.jpg 3x, blob:https://x/y 4x">`);
    expect(out).toContain('srcset="https://site.example/ok.jpg 3x"');
    const srcset = / srcset="([^"]*)"/.exec(out)?.[1] ?? "";
    expect(srcset).not.toMatch(/javascript:|blob:|data:/);
  });
});
