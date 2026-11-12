import { htmlToPlainText } from "@/lib/article-kind";
import { textWords } from "@/lib/extraction-quality";

export const RECENT_FULL_TEXT_LIMIT = 64;
export const MAX_DUPLICATE_SHINGLES = 256;
const MIN_UNIQUE_SHINGLES = 24;

/** String sets avoid cryptographic hashing on the sync event loop. Only the
 * opening 259 tokens are considered; cost and retained memory are fixed. */
function shingles(html: string): Set<string> {
    const words = textWords(htmlToPlainText(html.slice(0, 32_000)).slice(0, 8000)).slice(0, MAX_DUPLICATE_SHINGLES + 3);
    const out = new Set<string>();
    for (let i = 0; i + 4 <= words.length; i++) out.add(words.slice(i, i + 4).join(" "));
    return out;
}

function overlap(a: Set<string>, b: Set<string>): number {
    let shared = 0;
    for (const value of a) if (b.has(value)) shared++;
    return shared / Math.max(a.size, b.size, 1);
}

/** A shared page is suspicious only when meaningful feed baselines disagree. */
export function baselinesDiffer(a: string, b: string): boolean {
    if (htmlToPlainText(a).length < 160 || htmlToPlainText(b).length < 160) return false;
    const left = shingles(a);
    const right = shingles(b);
    return Math.min(left.size, right.size) >= MIN_UNIQUE_SHINGLES && overlap(left, right) < 0.5;
}

/** Potential page matches only; callers must verify differing feed baselines.
 * Per-feed fixed window. Neither crypto nor a scan of historical rows. */
export class RecentFullTextIndex {
    private entries = new Map<string, { link: string; shingles: Set<string> }>();

    observe(id: string, link: string, html: string): string[] {
        const next = shingles(html);
        const matches: string[] = [];
        if (next.size >= MIN_UNIQUE_SHINGLES) {
            for (const [otherId, other] of this.entries) {
                if (otherId !== id && other.link !== link && other.shingles.size >= MIN_UNIQUE_SHINGLES && overlap(next, other.shingles) >= 0.9) matches.push(otherId);
            }
        }
        this.entries.delete(id);
        this.entries.set(id, { link, shingles: next });
        if (this.entries.size > RECENT_FULL_TEXT_LIMIT) this.entries.delete(this.entries.keys().next().value!);
        return matches;
    }
}
