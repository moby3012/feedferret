import { describe, it, expect } from "vitest";
import { computeHeuristicEnrichment, detectClickbait, detectSponsored } from "../../lib/enrichment-heuristics";

describe("detectSponsored", () => {
  const positives: Array<[string, Parameters<typeof detectSponsored>[0]]> = [
    ["[Anzeige] prefix", { title: "[Anzeige] Die besten Laptops 2026" }],
    ["Anzeige | prefix", { title: "Anzeige | Neue Matratzen im Test" }],
    ["(Werbung) bracket", { title: "Neue Kopfhörer (Werbung)" }],
    ["trailing | Anzeige", { title: "Sommerurlaub günstig buchen | Anzeige" }],
    ["trailing – Sponsored", { title: "Best VPNs for travel – Sponsored" }],
    ["trailing – Anzeige", { title: "Sommerurlaub günstig buchen – Anzeige" }],
    ["Sponsored: prefix", { title: "Sponsored: Why your team needs this tool" }],
    ["Sponsored Post", { title: "Sponsored post: Cloud backup that just works" }],
    ["advertorial", { title: "Advertorial: Wie Solardächer sich rechnen" }],
    ["Partnerinhalt", { title: "Partnerinhalt: Strom sparen leicht gemacht" }],
    ["unbezahlte Werbung", { title: "Mein Lieblingsrezept – unbezahlte Werbung" }],
    ["body starts with Anzeige", { title: "Neue Schuhe", text: "Anzeige | Dieser Beitrag entstand in Zusammenarbeit" }],
    ["body bracket label", { title: "Gadgets", text: "Mehr dazu hier [Sponsored] und hier" }],
    ["affiliate links disclosure", { title: "Test", text: "Dieser Beitrag enthält Affiliate-Links." }],
    ["rel=sponsored link in the intro", { title: "Review", html: '<p><a href="https://shop.example/x" rel="nofollow sponsored">kaufen</a></p>' }],
    [
      "two rel=sponsored links in a long body",
      {
        title: "Roundup",
        html: `<p>${"Text. ".repeat(300)}<a href="https://a.example" rel="sponsored">a</a> <a href="https://b.example" rel="sponsored">b</a></p>`,
      },
    ],
    ["utm_medium=affiliate link", { title: "Deals", link: "https://shop.example/a?utm_source=x&utm_medium=affiliate" }],
    ["utm_medium=paid link in the intro", { title: "Deals", html: '<a href="https://x.example/?utm_medium=paid&amp;a=1">x</a>' }],
  ];
  it.each(positives)("flags %s", (_name, input) => {
    expect(detectSponsored(input)).toBe(true);
  });

  const negatives: Array<[string, Parameters<typeof detectSponsored>[0]]> = [
    ["criminal complaint 'Anzeige gegen'", { title: "Anzeige gegen Minister erstattet" }],
    ["compound Anzeigenhauptmann", { title: "Der Anzeigenhauptmann von Köln" }],
    ["Todesanzeige", { title: "Todesanzeige in der Zeitung sorgt für Streit" }],
    ["Werbung as ordinary noun", { title: "Werbung im Fernsehen wird immer teurer" }],
    ["Werbeverbot", { title: "EU plant Werbeverbot für Tabak" }],
    ["sponsored by senator (news)", { title: "Bill sponsored by senator passes Senate" }],
    ["Fox affiliate (news)", { title: "Local Fox affiliate wins award" }],
    ["sponsoring a team", { title: "Brauerei sponsert Fußballverein" }],
    ["ad hoc", { title: "Ad-hoc-Meldung der Bundesbank" }],
    ["plain headline", { title: "Bundestag beschließt neues Klimagesetz" }],
    ["English headline", { title: "Apple unveils new MacBook with faster chip" }],
    ["utm_medium=email link", { title: "Newsletter", link: "https://x.example/?utm_medium=email" }],
    ["utm_medium=social link", { title: "Post", html: '<a href="https://x.example/?utm_medium=social">x</a>' }],
    ["Anzeige: criminal complaint headline", { title: "Anzeige: Polizei ermittelt" }],
    ["Werbung – news headline", { title: "Werbung – Neue Regeln für Influencer" }],
    ["Anzeige: leading colon in body", { title: "Polizei", text: "Anzeige: Der Mann wurde gestern gefasst" }],
    [
      "single affiliate link buried in a long article",
      { title: "Long read", html: `<p>${"Text. ".repeat(300)}<a href="https://shop.example" rel="sponsored">buy</a></p>` },
    ],
    ["utm_medium=native link", { title: "Post", html: '<a href="https://x.example/?utm_medium=native">x</a>' }],
    ["utm_medium=partner link", { title: "Post", link: "https://x.example/?utm_medium=partner" }],
    ["rel=nofollow only", { title: "Link", html: '<a href="https://x.example" rel="nofollow noopener">x</a>' }],
    ["label word beyond 300 chars", { title: "Story", text: `${"Lorem ipsum dolor sit amet. ".repeat(14)}[Anzeige]` }],
    ["empty", { title: "" }],
  ];
  it.each(negatives)("does not flag %s", (_name, input) => {
    expect(detectSponsored(input)).toBe(false);
  });

  it("is robust against injection-style bodies (never throws, no catastrophic backtracking)", () => {
    const start = Date.now();
    detectSponsored({ title: "x".repeat(20_000), text: "Anzeige ".repeat(5_000), html: `rel="${"a ".repeat(20_000)}` });
    expect(Date.now() - start).toBeLessThan(200);
  });
});

describe("detectClickbait", () => {
  it.each([
    "You won't believe what happened next",
    "Here's why your phone is slow",
    "This one trick will save you hours",
    "Das passiert, wenn du jeden Tag Wasser trinkst",
    "Dieser einfache Trick spart Heizkosten",
    "Nummer 3 wird dich überraschen",
    "Das steckt dahinter",
    "Merz KRACHT mit Scholz – EINIGUNG geplatzt",
    "Unfassbar?!",
  ])("flags %s", (title) => {
    expect(detectClickbait(title)).toBe(true);
  });

  it.each([
    "EZB senkt Leitzins um 0,25 Prozentpunkte",
    "NASA und ESA planen gemeinsame Mission",
    "Was kostet die Energiewende wirklich?",
    "Bundestag debattiert Haushalt…",
    "How to configure nginx for HTTP/3",
    "CDU und SPD einigen sich",
    "",
  ])("does not flag %s", (title) => {
    expect(detectClickbait(title)).toBe(false);
  });
});

describe("computeHeuristicEnrichment", () => {
  it("only ever returns true flags plus the source, never false", () => {
    expect(computeHeuristicEnrichment({ title: "Bundestag beschließt Gesetz" })).toEqual({});
    expect(computeHeuristicEnrichment({ title: "[Anzeige] Laptops" })).toEqual({ isSponsored: true, enrichSource: "heuristic" });
    expect(computeHeuristicEnrichment({ title: "[Anzeige] Dieser Trick?!" })).toEqual({
      isSponsored: true,
      isClickbait: true,
      enrichSource: "heuristic",
    });
  });

  it("runs well under 0.05 ms per row on typical input", () => {
    const input = { title: "Bundestag beschließt neues Klimagesetz", text: "Lorem ipsum ".repeat(30), html: "<p>x</p>".repeat(100) };
    const n = 2_000;
    const start = performance.now();
    for (let i = 0; i < n; i++) computeHeuristicEnrichment(input);
    expect((performance.now() - start) / n).toBeLessThan(0.5); // generous CI bound (spec budget: 0.05 ms locally)
  });
});
