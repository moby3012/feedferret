import { describe, expect, it } from "vitest";
import { RecentFullTextIndex, RECENT_FULL_TEXT_LIMIT, baselinesDiffer } from "@/lib/full-text-duplicates";
import { assessExtraction, decideFullText, leadCoverage } from "@/lib/extraction-quality";
import { runInHtmlWorker } from "@/lib/html-worker";

const prose = Array.from({ length: 20 }, (_, i) => `Paragraph ${i} describes the observatory telescope mirrors and the mountain expedition with precise measurements from the winter survey.`).join(" ");

describe("cross-item full text", () => {
    it("matches identical and near-identical pages at different links, ignoring markup and case", () => {
        const index = new RecentFullTextIndex();
        expect(index.observe("a", "https://example.test/a", `<p>${prose}</p>`)).toEqual([]);
        expect(index.observe("a", "https://example.test/a", `<p>${prose}</p>`)).toEqual([]);
        expect(index.observe("alias", "https://example.test/a", `<div>${prose.toUpperCase()}</div>`)).toEqual([]);
        expect(index.observe("b", "https://example.test/b", `<div>${prose} Updated today.</div>`)).toContain("a");
        expect(index.observe("c", "https://example.test/c", "An unrelated discussion about wildlife conservation and wetlands. ".repeat(30))).toEqual([]);
    });
    it("uses a bounded recent window and a separate index per feed", () => {
        const index = new RecentFullTextIndex();
        index.observe("old", "/old", prose);
        for (let i = 0; i < RECENT_FULL_TEXT_LIMIT; i++) index.observe(String(i), `/${i}`, `Different historical entry ${i}. `.repeat(100));
        expect(index.observe("new", "/new", prose)).toEqual([]);
        expect(new RecentFullTextIndex().observe("other-feed", "/other", prose)).toEqual([]);
    });
});

it("protects substantial feed leads even when the wrong page is longer", () => {
    const feed = `<p>${prose.slice(0, 800)}</p>`;
    const wrong = "The estuary birds migrate each spring to coastal wetlands where conservation teams monitor nesting grounds. ".repeat(40);
    expect(decideFullText(assessExtraction(wrong), feed, "auto", wrong)).toEqual({ accept: false, reason: "lead_mismatch" });
    expect(decideFullText(assessExtraction(prose), feed, "auto", prose).accept).toBe(true);
});

it.each([
    '<div id="root"></div><script type="module" src="/app.js"></script>',
    '<noscript>Please enable JavaScript to continue.</noscript><div id="app"></div>',
    '<p>Bitte aktivieren Sie JavaScript.</p>',
])("detects sparse JS shells in both HTML worker paths: %s", async (page) => {
    const readable = await runInHtmlWorker({ task: "readability", html: page, url: "https://example.test/app" });
    const selector = await runInHtmlWorker({ task: "css", html: page, url: "https://example.test/app", selector: "#app", mode: "sync" });
    expect(readable.quality?.reason).toBe("js_shell");
    expect(selector.quality?.reason).toBe("js_shell");
});

it("trims multilingual chrome in the selector worker and keeps prose mentioning a browser check", async () => {
    const page = `<article><div>Share via: <a href="/share">Send</a></div><p>${prose}</p><div>Teilen via: <a href="/send">Senden</a></div><div>Sitzung wird überprüft…</div><div>Checking your browser</div></article>`;
    const result = await runInHtmlWorker({ task: "css", html: page, url: "https://example.test/story", selector: "article", mode: "sync" });
    expect(result.html).toContain(prose);
    expect(result.html).not.toMatch(/Share via|Teilen via|Sitzung|Checking your browser/);
    const longArticle = `<article><p>${prose} Checking your browser is a phrase discussed in this report.</p></article>`;
    const kept = await runInHtmlWorker({ task: "css", html: longArticle, url: "https://example.test/story", mode: "sync" });
    expect(kept.quality?.verdict).toBe("good");
    expect(kept.html).toContain("Checking your browser");
});


it("accepts a paraphrased teaser and bypasses lead checking for manual fetches", () => {
    const feed = "Astronomers study distant stars using observatory telescope mirrors. A mountain expedition gathered precise winter measurements. ".repeat(4);
    const page = "The winter survey gathered precise measurements. Researchers climbed the mountain to investigate distant stars and test telescope equipment. ".repeat(12);
    expect(decideFullText(assessExtraction(page), feed, "auto", page).accept).toBe(true);
    const unrelated = "Marine wildlife migrates along coastal habitats every spring. ".repeat(30);
    expect(decideFullText(assessExtraction(unrelated), feed, "manual", unrelated).accept).toBe(true);
});

it("requires distinct substantive feed baselines, preserving shared footers and templates", () => {
    const baseline = "This release improves keyboard navigation and updates the preferences panel with several accessibility features. ".repeat(3);
    expect(baselinesDiffer(baseline, baseline.replace("release", "update"))).toBe(false);
    expect(baselinesDiffer("", baseline)).toBe(false);
    expect(baselinesDiffer("Brief teaser", baseline)).toBe(false);
    expect(baselinesDiffer("Repeated words only. ".repeat(50), baseline)).toBe(false);
    const footer = prose.repeat(5);
    const index = new RecentFullTextIndex();
    index.observe("a", "/a", `Short article one. ${footer}`);
    expect(index.observe("b", "/b", `Short article two. ${footer}`)).toContain("a");
    // A page match alone never triggers the guard for templated feed posts.
    expect(baselinesDiffer(baseline, baseline)).toBe(false);
});

it.each([
    "Les États doivent partager les ressources pour protéger les communautés.",
    "Il faut départager les candidats avant le scrutin.",
    "Debemos compartir los resultados con toda la comunidad.",
    "Teilen ist für die Zusammenarbeit und den Austausch wichtig.",
    "Wir teilen die Ergebnisse mit allen Beteiligten.",
    "By Jane Doe",
])("preserves plain edge prose and bylines: %s", async (sentence) => {
    const html = `<article><p>${prose}</p><div>${sentence}</div></article>`;
    const result = await runInHtmlWorker({ task: "css", html, url: "https://example.test/story", mode: "sync", selector: "article" });
    expect(result.html).toContain(sentence);
});

it("preserves a legitimate short article with an ancillary JavaScript prompt", async () => {
    const { isJavaScriptShell } = await import("@/lib/extraction-shell-core");
    const html = `<article><p>${prose.slice(0, 230)}</p><noscript>enable JavaScript for comments</noscript></article>`;
    expect(isJavaScriptShell(html, "https://example.test/story")).toBe(false);
});


it.each(["div", "body"])("accepts short prose in plain %s markup beside a scripted fallback", async (tag) => {
    const { isJavaScriptShell } = await import("@/lib/extraction-shell-core");
    expect(isJavaScriptShell(`<${tag}>${prose.slice(0, 230)}</${tag}><noscript>enable JavaScript</noscript><script src="/app.js"></script>`, "https://example.test/story")).toBe(false);
});

it("skips DOM allocation for long visible prose, excluding script/style payloads", async () => {
    const { isJavaScriptShell } = await import("@/lib/extraction-shell-core");
    // An invalid URL would throw if JSDOM were constructed.
    expect(isJavaScriptShell(`<div>${prose}</div><script src="/app.js"></script>`, "invalid URL")).toBe(false);
    expect(isJavaScriptShell(`<div id="root"></div><script>${prose}</script><style>${prose}</style><script src="/app.js"></script>`, "https://example.test/app")).toBe(true);
});

it("ignores a long feed-wide footer when comparing short distinct article bodies", () => {
    const index = new RecentFullTextIndex();
    const footer = Array.from({ length: 400 }, (_, i) => `footerword${i}`).join(" ");
    for (let i = 0; i < 3; i++) index.observe(`history-${i}`, `/history-${i}`, `A brief historical story number ${i} with distinct details. ${footer}`);
    expect(index.observe("new", "/new", `Seabirds return to the protected estuary after their annual migration. ${footer}`)).toEqual([]);
});

it("compares only the candidate lead, ignoring matching text in a long tail", () => {
    const baseline = prose.slice(0, 800);
    const unrelated = "Marine habitats protect migrating seabirds along coastal wetlands. ".repeat(40);
    expect(leadCoverage(baseline, `<div>${unrelated}</div><p>${baseline}</p>`)).toBe(0);
    expect(leadCoverage(baseline, `<script>${unrelated}</script><p>${baseline}</p>${unrelated}`)).toBe(1);
});
