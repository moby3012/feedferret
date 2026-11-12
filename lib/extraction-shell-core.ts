// HTML worker only. Detect a sparse scripted application, never a prose article.
import { JSDOM } from "jsdom";

export function isJavaScriptShell(html: string, url: string): boolean {
    const dom = new JSDOM(html, { url });
    try {
        const doc = dom.window.document;
        const scripted = !!doc.querySelector("script[src], script[type='module']");
        doc.querySelectorAll("script, style, svg, template").forEach((el) => el.remove());
        const text = (doc.body.textContent ?? "").replace(/\s+/g, " ").trim();
        const prompt = /enable javascript|javascript (?:is )?(?:disabled|required)|javascript aktivieren|aktivieren sie javascript|activez javascript|habilit[ae] javascript|attiva javascript/i.test(text);
        return text.length < 500 && (prompt || (scripted && text.length < 80));
    } finally {
        dom.window.close();
    }
}
