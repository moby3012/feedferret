// HTML worker only. Detect a sparse scripted application, never a prose article.
import { JSDOM } from "jsdom";

export function isJavaScriptShell(html: string, url: string): boolean {
    // Ordinary static articles avoid an extra DOM allocation entirely.
    if (!/javascript|<script\b/i.test(html)) return false;
    const dom = new JSDOM(html, { url });
    try {
        const doc = dom.window.document;
        const scripted = !!doc.querySelector("script[src], script[type='module']");
        doc.querySelectorAll("script, style, svg, template").forEach((el) => el.remove());
        const text = (doc.body.textContent ?? "").replace(/\s+/g, " ").trim();
        const prompt = text.match(/enable javascript|javascript (?:is )?(?:disabled|required)|javascript aktivieren|aktivieren sie javascript|activez javascript|habilit[ae] javascript|attiva javascript/i);
        const proseBlock = Array.from(doc.querySelectorAll("article, main, p")).some((el) => {
            const clone = el.cloneNode(true) as Element;
            clone.querySelectorAll("noscript").forEach((node) => node.remove());
            return (clone.textContent ?? "").trim().length > 200;
        });
        const promptDominates = !!prompt && prompt[0].length / Math.max(1, text.length) >= 0.25;
        return text.length < 500 && ((!!prompt && (promptDominates || !proseBlock)) || (scripted && text.length < 80));
    } finally {
        dom.window.close();
    }
}
