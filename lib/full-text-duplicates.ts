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
    // Incremental document frequencies/postings: no rebuilding ~16k historical
    // shingles for each observation. Empty postings are released on replacement/eviction.
    private shingleDocuments = new Map<string, Set<string>>();

    private remove(id: string): void {
        const old = this.entries.get(id);
        if (!old) return;
        for (const value of old.shingles) {
            const documents = this.shingleDocuments.get(value)!;
            documents.delete(id);
            if (!documents.size) this.shingleDocuments.delete(value);
        }
        this.entries.delete(id);
    }

    observe(id: string, link: string, html: string): string[] {
        const next = shingles(html);
        this.remove(id);
        const shared = new Map<string, number>();
        if (next.size >= MIN_UNIQUE_SHINGLES) {
            for (const value of next) {
                for (const otherId of this.shingleDocuments.get(value) ?? []) {
                    shared.set(otherId, (shared.get(otherId) ?? 0) + 1);
                }
            }
        }
        // Full-set overlap generates candidates even for generic pages with
        // per-item headings. The caller must veto matches containing the feed lead.
        const matches: string[] = [];
        for (const [otherId, count] of shared) {
            const other = this.entries.get(otherId)!;
            if (other.link !== link && other.shingles.size >= MIN_UNIQUE_SHINGLES &&
                count / Math.max(next.size, other.shingles.size) >= 0.9) matches.push(otherId);
        }
        this.entries.set(id, { link, shingles: next });
        for (const value of next) {
            const documents = this.shingleDocuments.get(value) ?? new Set<string>();
            documents.add(id);
            this.shingleDocuments.set(value, documents);
        }
        if (this.entries.size > RECENT_FULL_TEXT_LIMIT) this.remove(this.entries.keys().next().value!);
        return matches;
    }
}
