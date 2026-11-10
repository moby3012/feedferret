/**
 * Translates FreshRSS "mark as read" filters (`frss:filtersActionRead`, one search
 * expression per line) into FeedFerret constructs.
 *
 * FreshRSS stores each filter as a search expression (title/content keywords,
 * `intitle:`, `author:`, `inurl:`, `-negation`, quotes, `OR`, …). FeedFerret's
 * per-feed `filtersActionRead` is only a list of literal keywords, so importing
 * the raw text silently changes which articles are marked read. Instead:
 *
 *  - a line that is a single plain keyword or quoted phrase stays a literal
 *    keyword (identical semantics: title + body substring, case-insensitive);
 *  - a line made only of constructs FeedFerret's search can express exactly is
 *    emitted as a query for a feed-scoped auto-read rule. That means field terms
 *    (`intitle:`, `intext:`, `author:`, `inurl:`) and negated words; the result is
 *    never looser than the original, and every emitted value is checked to survive
 *    FeedFerret's query tokenizer unchanged (no `:`, `"` or `'` in free text/quotes);
 *  - everything else is reported and NOT imported. A filter is never translated
 *    partially or approximately: a looser filter would mark articles read that
 *    FreshRSS kept. In particular plain words inside a multi-term filter are NOT
 *    translated, because FeedFerret's free-text search also matches author, link,
 *    feed name and labels whereas FreshRSS matches title and content only.
 */

export interface FilterTranslation {
  /** Lines that stay literal keywords in `Feed.filtersActionRead`. */
  keywordLines: string[];
  /** FeedFerret search queries (one per source line) for a feed-scoped mark-read rule. */
  ruleQueries: string[];
  /** Source lines that cannot be expressed; never imported. */
  unsupported: { line: string; reason: string }[];
}

/**
 * FeedFerret's query tokenizer (lib/search.ts) treats `"…"`/`'…'` as phrase delimiters and
 * the first `:` of a token as a field separator, so a value containing them is re-read as
 * something broader or different. Such values are never emitted.
 */
function assertTokenizerSafe(value: string) {
  if (/["']/.test(value)) throw new Unsupported("value contains a quote character that FeedFerret search would re-interpret");
}

type Term = { negated: boolean; field: string | null; value: string; quoted: boolean; regex: boolean };

const FIELD_NAMES = new Set([
  "intitle", "intext", "author", "inurl",
  "date", "pubdate", "mdate", "userdate",
  "f", "c", "e", "l", "s", "search", "t", "is",
]);
const SUPPORTED_FIELDS = new Set(["intitle", "intext", "author", "inurl"]);

class Unsupported extends Error {}

function tokenize(line: string): Array<Term | "OR"> {
  const out: Array<Term | "OR"> = [];
  let i = 0;
  while (i < line.length) {
    if (/\s/.test(line[i])) { i++; continue; }
    if (line[i] === "(" || line[i] === ")") throw new Unsupported("parentheses are not supported");

    let negated = false;
    if ((line[i] === "-" || line[i] === "!") && i + 1 < line.length && !/\s/.test(line[i + 1])) {
      negated = true;
      i++;
    }

    if (line[i] === "#") throw new Unsupported("label/tag filters (#tag) are not supported");

    let field: string | null = null;
    const fieldMatch = /^([A-Za-z]+):/.exec(line.slice(i));
    if (fieldMatch && FIELD_NAMES.has(fieldMatch[1].toLowerCase())) {
      field = fieldMatch[1].toLowerCase();
      i += fieldMatch[0].length;
    }

    let value = "";
    let quoted = false;
    let regex = false;
    const quote = line[i];
    if (quote === '"' || quote === "'") {
      const end = line.indexOf(quote, i + 1);
      if (end === -1) throw new Unsupported("unterminated quote");
      value = line.slice(i + 1, end);
      quoted = true;
      i = end + 1;
    } else if (quote === "/" && /\/(?=\s|$)/.test(line.slice(i + 1))) {
      // `/…/` is a regular expression only when a closing slash ends a word; a path
      // such as `inurl:/jobs/2024` is a plain value.
      const end = i + 1 + line.slice(i + 1).search(/\/(?=\s|$)/);
      value = line.slice(i, end + 1);
      regex = true;
      i = end + 1;
    } else {
      let end = i;
      while (end < line.length && !/\s/.test(line[end]) && line[end] !== "(" && line[end] !== ")") end++;
      value = line.slice(i, end);
      i = end;
    }

    if (!negated && !field && !quoted && !regex && value === "OR") {
      out.push("OR");
      continue;
    }
    out.push({ negated, field, value, quoted, regex });
  }
  return out;
}

function emitTerm(term: Term): { tokens: string[] } {
  if (term.regex) throw new Unsupported("regular expressions are not supported");
  if (term.field && !SUPPORTED_FIELDS.has(term.field)) {
    throw new Unsupported(`'${term.field}:' filters have no FeedFerret equivalent`);
  }
  if (!term.value.trim()) throw new Unsupported("empty filter value");

  if (term.field) {
    if (/\s/.test(term.value)) {
      throw new Unsupported(`multi-word value for '${term.field}:' cannot be expressed in FeedFerret search`);
    }
    assertTokenizerSafe(term.value);
    return { tokens: [`${term.negated ? "-" : ""}${term.field}:${term.value}`] };
  }

  // FeedFerret would read these as operators / field filters, not as plain text.
  if (term.value.toUpperCase() === "OR" || /^[A-Za-z]+:/.test(term.value) || /^[#!-]/.test(term.value)) {
    throw new Unsupported("plain term would be read as a FeedFerret search operator");
  }

  // Free text. FreshRSS matches title + content. FeedFerret's free-text search additionally
  // matches author, link, feed name and labels, so a positive word can only be translated
  // when it is the line's single term (then it is a literal keyword, handled by the caller).
  // A value with `:` would be read as `field:value`, quotes would be re-tokenised.
  if (term.value.includes(":")) throw new Unsupported("value contains ':' which FeedFerret search would read as a field filter");
  assertTokenizerSafe(term.value);
  if (!term.negated) {
    throw new Unsupported("plain words in a multi-term filter would also match author, link and feed name in FeedFerret");
  }
  if (/\s/.test(term.value)) throw new Unsupported("negated phrases cannot be expressed in FeedFerret search");
  // "not in title AND not in content" is exactly FreshRSS' negation.
  return { tokens: [`-intitle:${term.value}`, `-intext:${term.value}`] };
}

export function translateFreshRssReadFilters(raw: string | null | undefined): FilterTranslation {
  const result: FilterTranslation = { keywordLines: [], ruleQueries: [], unsupported: [] };
  if (!raw) return result;

  const seen = new Set<string>();
  for (const sourceLine of raw.split(/\r?\n/)) {
    const line = sourceLine.trim();
    if (!line || seen.has(line)) continue;
    seen.add(line);

    try {
      const tokens = tokenize(line);
      if (tokens.length === 0) continue;

      // Single positive plain keyword / quoted phrase: keep as a literal keyword.
      if (tokens.length === 1 && tokens[0] !== "OR") {
        const only = tokens[0];
        if (!only.negated && !only.field && !only.regex && only.value.trim()) {
          result.keywordLines.push(only.value.trim());
          continue;
        }
      }

      if (tokens[0] === "OR" || tokens[tokens.length - 1] === "OR") throw new Unsupported("dangling OR");

      const groups: string[][] = [[]];
      for (const token of tokens) {
        if (token === "OR") {
          groups.push([]);
          continue;
        }
        const emitted = emitTerm(token);
        groups[groups.length - 1].push(...emitted.tokens);
      }
      if (groups.some((group) => group.length === 0)) throw new Unsupported("empty OR branch");

      result.ruleQueries.push(groups.map((group) => group.join(" ")).join(" OR "));
    } catch (error) {
      if (!(error instanceof Unsupported)) throw error;
      result.unsupported.push({ line, reason: error.message });
    }
  }
  return result;
}
