import { describe, expect, it } from "vitest";
import {
  applyAliases,
  cleanTitle,
  computeStorySig,
  detectLang,
  extractEntities,
  extractOutboundLinks,
  foldText,
  normalizeTitle,
  parseSig,
  serializeSig,
  stem,
  stripPrefix,
  stripSiteSuffix,
  tokenize,
} from "../../lib/story-clustering/normalize";

describe("foldText", () => {
  it("lowercases, folds ß/umlauts/diacritics", () => {
    expect(foldText("Straße Äpfel Über Café")).toBe("strasse aepfel ueber cafe");
  });
});

describe("site suffix / prefix", () => {
  it("drops a tail that is the feed name or the host label", () => {
    expect(stripSiteSuffix("Deutsche Bahn streicht Fernverkehr wegen Sturm - SPIEGEL", { feedName: "DER SPIEGEL", host: "www.spiegel.de" })).toBe(
      "Deutsche Bahn streicht Fernverkehr wegen Sturm",
    );
    expect(stripSiteSuffix("Sturm: Bahn stellt Fernverkehr ein | tagesschau.de", { host: "www.tagesschau.de" })).toBe("Sturm: Bahn stellt Fernverkehr ein");
    expect(stripSiteSuffix("Fed holds rates - BBC News", { feedName: "BBC News", host: "bbc.co.uk" })).toBe("Fed holds rates");
  });
  it("keeps a tail that is part of the story", () => {
    expect(stripSiteSuffix("Apple event - what to expect", { feedName: "The Verge", host: "theverge.com" })).toBe("Apple event - what to expect");
    expect(stripSiteSuffix("Sturm: Bahn stellt Fernverkehr ein", { host: "spiegel.de" })).toBe("Sturm: Bahn stellt Fernverkehr ein");
  });
  it("strips format prefixes", () => {
    expect(stripPrefix("Eilmeldung: EZB senkt Leitzins")).toBe("EZB senkt Leitzins");
    expect(stripPrefix("BREAKING – Fed holds rates")).toBe("Fed holds rates");
    expect(stripPrefix("Analyse | Warum die Bahn pünktlicher wird")).toBe("Warum die Bahn pünktlicher wird");
    expect(stripPrefix("Updated rules for pets")).toBe("Updated rules for pets");
  });
  it("cleanTitle combines both", () => {
    expect(cleanTitle("Update: Sturm legt Bahn lahm - SPIEGEL", { feedName: "SPIEGEL" })).toBe("Sturm legt Bahn lahm");
  });
  it("normalizeTitle folds decimals", () => {
    expect(normalizeTitle("EZB senkt Leitzins um 0,25 Prozentpunkte")).toBe("ezb senkt leitzins um 0.25 prozentpunkte");
  });
});

describe("detectLang", () => {
  it("separates de and en by stopword hits", () => {
    expect(detectLang("EZB senkt Leitzins um 0,25 Prozentpunkte")).toBe("de");
    expect(detectLang("Apple unveils iPhone 17 with a new design")).toBe("en");
    expect(detectLang("Lufthansa-Piloten streiken am Donnerstag")).toBe("de");
  });
});

describe("tokenize", () => {
  it("drops stopwords, keeps numbers (decimals as one token), stems per language", () => {
    expect(tokenize("EZB senkt Leitzins um 0,25 Prozentpunkte", "de")).toEqual(["ecb", "cut", "leitzins", "0.25", "prozentpunkt"]);
    expect(tokenize("Apple unveils iPhone 17 with thinner design", "en")).toEqual(["apple", "unveil", "iphon", "17", "thinner", "design"]);
  });
  it("keeps CVE ids as one token", () => {
    expect(tokenize("Critical OpenSSH flaw CVE-2026-1234 lets attackers run code", "en")).toContain("cve-2026-1234");
  });
  it("splits hyphen compounds and maps aliases to one canonical token", () => {
    expect(tokenize("EZB-Zinsentscheid", "de")).toEqual(["ecb", "zinsentscheid"]);
    expect(tokenize("Europäische Zentralbank senkt", "de")).toEqual(["ecb", "cut"]);
    expect(tokenize("Federal Reserve keeps rates", "en")).toEqual(["fed", "hold", "rate"]);
  });
  it("maps newsroom verb synonyms to one token", () => {
    expect(tokenize("Bundestag stimmt für Reform", "de")).toContain("vote");
    expect(tokenize("Bundestag beschließt Reform", "de")).toContain("vote");
  });
  it("dedupes and caps at 16", () => {
    const long = Array.from({ length: 30 }, (_, i) => `wort${i}abc`).join(" ");
    expect(tokenize(long, "de")).toHaveLength(16);
    expect(tokenize("Sturm Sturm Sturm", "de")).toEqual(["sturm"]);
  });
  it("stem keeps short stems intact", () => {
    expect(stem("senken", "de")).toBe("senk");
    expect(stem("leitzins", "de")).toBe("leitzins"); // nominative -s is not an inflection
    expect(stem("leitzinsen", "de")).toBe("leitzins");
    expect(stem("nein", "de")).toBe("nein"); // too short to stem
    expect(stem("a19", "en")).toBe("a19");
    expect(stem("unveiled", "en")).toBe("unveil");
    expect(stem("announces", "en")).toBe("announc");
  });
});

describe("extractEntities", () => {
  it("(a) all-caps acronyms, (b) letter+digit / decimals / codes, (c) mixed case", () => {
    expect(extractEntities("Apple unveils iPhone 17 with A19 chip", null, "en")).toEqual(expect.arrayContaining(["iphone", "iphone17", "a19"]));
    expect(extractEntities("Erdbeben der Stärke 6,1 erschüttert Türkei", null, "de")).toEqual(["6.1"]);
    expect(extractEntities("Critical OpenSSH flaw CVE-2026-1234 lets attackers run code", null, "en")).toEqual(expect.arrayContaining(["cve-2026-1234", "openssh"]));
    expect(extractEntities("NASA und ESA planen Mondmission", null, "de")).toEqual(expect.arrayContaining(["nasa", "esa"]));
  });
  it("maps aliases to a canonical id (EZB ≡ Europäische Zentralbank, Fed ≡ Federal Reserve)", () => {
    expect(extractEntities("EZB senkt Leitzins", null, "de")).toContain("ecb");
    expect(extractEntities("Zinswende: Europäische Zentralbank senkt Leitzins erneut", null, "de")).toContain("ecb");
    expect(extractEntities("Federal Reserve keeps rates unchanged", null, "en")).toContain("fed");
    expect(extractEntities("Fed holds interest rates steady", null, "en")).toContain("fed");
  });
  it("(d) capitalized non-initial words only for English, never in Title Case or German", () => {
    expect(extractEntities("Everything Apple announced at today's event", null, "en")).toContain("~apple");
    expect(extractEntities("Apple Unveils New Phone With Better Camera", null, "en")).toEqual([]);
    expect(extractEntities("Bayern gewinnt gegen Dortmund", null, "de")).toEqual([]);
  });
  it("ignores years and 2-digit numbers, caps at 8", () => {
    expect(extractEntities("Zwei Kürzungen in 2026 und 17 Fälle", null, "de")).toEqual([]);
    const many = Array.from({ length: 14 }, (_, i) => `A${i}B`).join(" ");
    expect(extractEntities(many, null, "en").length).toBeLessThanOrEqual(8);
  });
  it("uses the first 300 chars of the excerpt", () => {
    expect(extractEntities("Neue Studie", "Die NASA veröffentlicht Daten", "de")).toContain("nasa");
  });
});

describe("extractOutboundLinks", () => {
  const body = (urls: string[]) => urls.map((u) => `<a href="${u}">x</a>`).join("");
  it("keeps external article links, hashes them to 12 hex chars", () => {
    const out = extractOutboundLinks(body(["https://advisories.example.org/openssh/2026/cve-2026-1234"]), "https://ars.example/a");
    expect(out).toHaveLength(1);
    expect(out[0]).toMatch(/^[0-9a-f]{12}$/);
  });
  it("normalizes tracking params / www / trailing slash to the same hash", () => {
    const a = extractOutboundLinks(body(["https://www.example.org/news/story-1/?utm_source=x"]), "https://a.test/1");
    const b = extractOutboundLinks(body(["https://example.org/news/story-1"]), "https://b.test/2");
    expect(a).toEqual(b);
  });
  it("drops own-host, social/shortener hosts, homepages and non-http links", () => {
    expect(
      extractOutboundLinks(
        body(["https://www.spiegel.de/politik/x-1", "https://twitter.com/user/status/1", "https://bit.ly/abc123", "https://other.example.org/", "https://other.example.org/about", "mailto:a@b.c", "javascript:alert(1)"]),
        "https://www.spiegel.de/a/1",
      ),
    ).toEqual([]);
  });
  it("caps at 8 and only scans the first 20 KB", () => {
    const many = body(Array.from({ length: 20 }, (_, i) => `https://src${i}.example.org/news/story-number-${i}`));
    expect(extractOutboundLinks(many, "https://a.test/1")).toHaveLength(8);
    const late = "x".repeat(25_000) + body(["https://late.example.org/news/story-number-1"]);
    expect(extractOutboundLinks(late, "https://a.test/1")).toEqual([]);
  });
});

describe("computeStorySig", () => {
  it("builds a compact, serializable signature (≤ 600 chars)", () => {
    const sig = computeStorySig({
      title: "Apple unveils iPhone 17 with thinner design and A19 chip - The Verge",
      excerpt: "Apple today announced the iPhone 17 …",
      link: "https://www.theverge.com/a/1",
      feedName: "The Verge",
      feedPriority: "category",
      imageUrl: "https://img/1.jpg",
    });
    expect(sig.v).toBe(1);
    expect(sig.t).toContain("iphon");
    expect(sig.t).not.toContain("verge");
    expect(sig.x).toBeUndefined();
    const raw = serializeSig(sig);
    expect(raw.length).toBeLessThanOrEqual(600);
    expect(parseSig(raw)).toEqual(sig);
  });
  it("excludes liveblogs, newsletters, tiny titles, hidden feeds and duplicates", () => {
    expect(computeStorySig({ title: "Liveblog: Alle Entwicklungen zum Nahost-Konflikt" }).x).toBe(1);
    expect(computeStorySig({ title: "Newsletter: Die Woche in Zahlen" }).x).toBe(1);
    expect(computeStorySig({ title: "Ja" }).x).toBe(1);
    expect(computeStorySig({ title: "Apple unveils iPhone 17 with new design", feedPriority: "hidden" }).x).toBe(1);
    expect(computeStorySig({ title: "Apple unveils iPhone 17 with new design", isDuplicate: true }).x).toBe(1);
  });
  it("quality favors important feeds, images and long reads", () => {
    const base = { title: "Apple unveils iPhone 17 with new design" };
    const low = computeStorySig({ ...base, feedPriority: "feed" }).q!;
    const high = computeStorySig({ ...base, feedPriority: "important", imageUrl: "x", readMinutes: 5 }).q!;
    expect(high).toBeGreaterThan(low);
  });
  it("parseSig rejects junk", () => {
    expect(parseSig(null)).toBeNull();
    expect(parseSig("not json")).toBeNull();
    expect(parseSig('{"v":2,"t":[],"e":[],"l":[]}')).toBeNull();
  });
  it("applyAliases is idempotent on text without aliases", () => {
    expect(applyAliases("hello world").text).toBe("hello world");
  });
});
