// HTML worker only. Detect a sparse scripted application, never a prose article.
import { JSDOM } from "jsdom";
import { replaceComments, replaceElements } from "@/lib/linear-text";

/** Linear, quote-aware tag stripping: raw > inside an attribute is not prose. */
function visibleText(html: string): string {
    const source = replaceElements(replaceComments(html), ["script", "style", "svg", "template", "noscript"], " ", { unclosedToEnd: true });
    const parts: string[] = [];
    let start = 0;
    for (let i = 0; i < source.length; i++) {
        if (source[i] !== "<") continue;
        parts.push(source.slice(start, i), " ");
        let quote: string | null = null;
        for (i++; i < source.length; i++) {
            const ch = source[i];
            if (quote) { if (ch === quote) quote = null; }
            else if (ch === '"' || ch === "'") quote = ch;
            else if (ch === ">") break;
        }
        start = i + 1;
    }
    parts.push(source.slice(start));
    return parts.join("").replace(/&nbsp;|&#160;|&#xa0;/gi, " ").replace(/\s+/g, " ").trim();
}

export function isJavaScriptShell(html: string, url: string): boolean {
    // Ordinary static articles avoid an extra DOM allocation entirely.
    if (!/javascript|<script\b/i.test(html)) return false;
    const visible = visibleText(html);
    if (visible.length > 1500) return false;
    const dom = new JSDOM(html, { url });
    try {
        const doc = dom.window.document;
        const scripted = !!doc.querySelector("script[src], script[type='module']");
        doc.querySelectorAll("script, style, svg, template").forEach((el) => el.remove());
        const text = (doc.body.textContent ?? "").replace(/\s+/g, " ").trim();
        const prompt = text.match(/enable javascript|javascript (?:is )?(?:disabled|required)|javascript aktivieren|aktivieren sie javascript|activez javascript|habilit[ae] javascript|attiva javascript/i);
        // Prose need not use semantic article/paragraph markup. Exclude the
        // fallback prompt before measuring plain body/div text as well.
        doc.querySelectorAll("noscript").forEach((node) => node.remove());
        const proseBlock = (doc.body.textContent ?? "").replace(/\s+/g, " ").trim().length > 200;
        const promptDominates = !!prompt && prompt[0].length / Math.max(1, text.length) >= 0.25;
        return text.length < 500 && ((!!prompt && (promptDominates || !proseBlock)) || (scripted && text.length < 80));
    } finally {
        dom.window.close();
    }
}
