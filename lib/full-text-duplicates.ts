import { createHash } from "node:crypto";
import { htmlToPlainText } from "@/lib/article-kind";
import { textWords } from "@/lib/extraction-quality";

export const RECENT_FULL_TEXT_LIMIT = 64;

type Fingerprint = { hash: string; shingles: Set<string> };
function fingerprint(html: string): Fingerprint | null {
    const text = htmlToPlainText(html);
    if (text.length < 400) return null;
    const words = textWords(text).slice(0, 6000);
    const shingles = new Set<string>();
    for (let i = 0; i + 4 <= words.length; i++) {
        shingles.add(createHash("sha256").update(words.slice(i, i + 4).join(" ")).digest("hex").slice(0, 16));
    }
    return { hash: createHash("sha256").update(words.join(" ")).digest("hex"), shingles };
}

/** Per-feed, bounded recent window, including rejected candidates in this batch.
 * At most 64 comparisons/item, each on at most 6000 tokens; never scans history.
 */
export class RecentFullTextIndex {
    private entries = new Map<string, { link: string; fingerprint: Fingerprint }>();

    observe(id: string, link: string, html: string): string[] {
        const next = fingerprint(html);
        if (!next) return [];
        const matches: string[] = [];
        for (const [otherId, other] of this.entries) {
            if (otherId === id || other.link === link) continue;
            const prev = other.fingerprint;
            let same = prev.hash === next.hash;
            if (!same && Math.min(prev.shingles.size, next.shingles.size) >= 20) {
                let overlap = 0;
                for (const shingle of next.shingles) if (prev.shingles.has(shingle)) overlap++;
                same = overlap / Math.max(prev.shingles.size, next.shingles.size) >= 0.9;
            }
            if (same) matches.push(otherId);
        }
        this.entries.delete(id);
        this.entries.set(id, { link, fingerprint: next });
        if (this.entries.size > RECENT_FULL_TEXT_LIMIT) this.entries.delete(this.entries.keys().next().value!);
        return matches;
    }
}
