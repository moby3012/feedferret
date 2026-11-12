import { describe, expect, it } from "vitest";
import { RecentFullTextIndex, RECENT_FULL_TEXT_LIMIT } from "@/lib/full-text-duplicates";
import { assessExtraction, decideFullText } from "@/lib/extraction-quality";
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
    const page = `<article><div>Share via: <a href="/share">Send</a></div><p>${prose}</p><div>Teilen via: <a href="/send">Senden</a></div><div>Kommentare Sitzung wird überprüft…</div><div>Checking your browser</div></article>`;
    const result = await runInHtmlWorker({ task: "css", html: page, url: "https://example.test/story", selector: "article", mode: "sync" });
    expect(result.html).toContain(prose);
    expect(result.html).not.toMatch(/Share via|Teilen via|Sitzung|Checking your browser/);
    const longArticle = `<article><p>${prose} Checking your browser is a phrase discussed in this report.</p></article>`;
    const kept = await runInHtmlWorker({ task: "css", html: longArticle, url: "https://example.test/story", mode: "sync" });
    expect(kept.quality?.verdict).toBe("good");
    expect(kept.html).toContain("Checking your browser");
});


it("does not mistake shared topical vocabulary for the lead of a substantial feed item", () => {
    const words = Array.from({ length: 90 }, (_, i) => `observation${i}`);
    const feed = words.join(" ");
    const wrong = [...words].reverse().join(" ").repeat(4);
    expect(decideFullText(assessExtraction(wrong), feed, "auto", wrong)).toEqual({ accept: false, reason: "lead_mismatch" });
});
