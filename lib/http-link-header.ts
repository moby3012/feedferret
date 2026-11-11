/**
 * RFC 8288 `Link` header parser (structured, not split-on-comma):
 *   Link = #link-value; link-value = "<" URI-Reference ">" *( OWS ";" OWS link-param )
 *   link-param = token BWS [ "=" BWS ( token / quoted-string ) ]
 * Commas inside `<…>` or quoted strings do not separate links; quoted-string
 * escapes (`\"`) are honoured; `title*` (RFC 8187) is decoded. Per RFC 8288 §3
 * only the first occurrence of a parameter counts. `rel` is split into its
 * (lower-cased) relation types for exact token matching.
 */

export type HttpLinkEntry = {
  /** Target as written (may be relative — resolve against the final response URL). */
  url: string;
  /** Lower-cased relation types from `rel`. */
  rels: string[];
  /** Lower-cased media type from `type` (without parameters). */
  type?: string;
  title?: string;
};

const isWs = (ch: string | undefined) => ch === " " || ch === "\t" || ch === "\r" || ch === "\n";

function decodeExtValue(value: string): string | null {
  // RFC 8187: charset'lang'pct-encoded
  const m = /^([a-z0-9!#$%&+^_`{}~-]+)'[^']*'(.*)$/i.exec(value);
  if (!m) return null;
  try {
    if (m[1].toLowerCase() === "utf-8") return decodeURIComponent(m[2]);
    if (m[1].toLowerCase() === "iso-8859-1") return m[2].replace(/%([0-9a-f]{2})/gi, (_, hex: string) => String.fromCharCode(parseInt(hex, 16)));
  } catch {
    // malformed percent-encoding
  }
  return null;
}

export function parseHttpLinkHeader(header: string | null | undefined): HttpLinkEntry[] {
  if (!header) return [];
  const s = header;
  const out: HttpLinkEntry[] = [];
  let i = 0;
  const skipWs = () => {
    while (isWs(s[i])) i++;
  };

  while (i < s.length) {
    while (i < s.length && (isWs(s[i]) || s[i] === ",")) i++;
    if (i >= s.length) break;
    if (s[i] !== "<") {
      // Malformed link-value: skip to the next top-level comma.
      while (i < s.length && s[i] !== ",") {
        if (s[i] === '"') {
          i++;
          while (i < s.length && s[i] !== '"') i += s[i] === "\\" ? 2 : 1;
        }
        i++;
      }
      continue;
    }
    const close = s.indexOf(">", i + 1);
    if (close < 0) break;
    const url = s.slice(i + 1, close).trim();
    i = close + 1;

    const params = new Map<string, string>();
    while (i < s.length) {
      skipWs();
      if (s[i] !== ";") break;
      i++;
      skipWs();
      const nameStart = i;
      while (i < s.length && !isWs(s[i]) && !"=;,".includes(s[i])) i++;
      const name = s.slice(nameStart, i).toLowerCase();
      skipWs();
      let value = "";
      if (s[i] === "=") {
        i++;
        skipWs();
        if (s[i] === '"') {
          i++;
          while (i < s.length && s[i] !== '"') {
            if (s[i] === "\\" && i + 1 < s.length) i++;
            value += s[i];
            i++;
          }
          i++; // closing quote
        } else {
          const valueStart = i;
          while (i < s.length && !isWs(s[i]) && s[i] !== ";" && s[i] !== ",") i++;
          value = s.slice(valueStart, i);
        }
      }
      if (name && !params.has(name)) params.set(name, value);
    }
    // Anything else up to the separating comma is garbage; skip it.
    skipWs();
    if (i < s.length && s[i] !== ",") {
      while (i < s.length && s[i] !== ",") i++;
    }

    if (!url) continue;
    const entry: HttpLinkEntry = {
      url,
      rels: (params.get("rel") ?? "").toLowerCase().split(/[ \t]+/).filter(Boolean),
    };
    const type = params.get("type")?.split(";")[0].trim().toLowerCase();
    if (type) entry.type = type;
    const titleStar = params.has("title*") ? decodeExtValue(params.get("title*")!) : null;
    const title = titleStar ?? params.get("title");
    if (title) entry.title = title;
    out.push(entry);
  }
  return out;
}
