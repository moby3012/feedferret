import { redactEncodedParamValues, redactUrlUserinfo } from "@/lib/linear-text";

// ------------------------------------------------------------ secret pairs
//
// `key=value`, `key: value`, `"key":"value"` and `"key"="value"` pairs in free text (query strings, log
// lines, JSON, headers). Hand-written scan, not a regex: quoted values need escape-aware matching and
// header values need "to end of line", and both are easier to keep linear this way.

/** Key names that mark a secret: the whole key, or the last `-` / `_` / `.` segment of it (`x-api-key`, `access_token`). */
const SECRET_KEY_NAMES = ["key", "apikey", "token", "secret", "password", "passwd", "pwd", "auth", "authorization", "sig", "signature", "cookie"];
/** Names that also count glued to a longer word (`myapikey`, `newpassword`). `key` / `token` are not here: `monkey` stays. */
const SECRET_KEY_SUFFIXES = ["apikey", "authorization", "password", "passwd"];
const AUTH_SCHEMES = ["bearer", "basic", "digest", "negotiate", "ntlm", "token"];

/** Is this key (a `[A-Za-z0-9_.-]` run) a secret name? Case-insensitive, anchored: `monkey`, `oauth`, `keyboard` are not. */
export function isSensitiveKeyName(name: string): boolean {
  const lower = name.toLowerCase();
  if (lower.length === 0) return false;
  if (SECRET_KEY_NAMES.some((n) => lower === n || lower.endsWith(`-${n}`) || lower.endsWith(`_${n}`) || lower.endsWith(`.${n}`))) return true;
  return SECRET_KEY_SUFFIXES.some((n) => lower.endsWith(n));
}

/** Header-style keys whose `:` value runs to the end of the line (`Authorization: Digest a="b", c="d"`, `Cookie: a=1; b=2`). */
function isLineValueName(name: string): boolean {
  const lower = name.toLowerCase();
  return lower.endsWith("authorization") || lower.endsWith("cookie");
}

const isKeyCode = (c: number) => (c >= 48 && c <= 57) || (c >= 65 && c <= 90) || (c >= 97 && c <= 122) || c === 95 || c === 45 || c === 46;
const isBlank = (c: string | undefined) => c === " " || c === "\t";
const isEol = (c: string | undefined) => c === "\n" || c === "\r";

function skipBlanks(s: string, i: number): number {
  while (i < s.length && isBlank(s[i])) i++;
  return i;
}

function lineEnd(s: string, i: number): number {
  while (i < s.length && !isEol(s[i])) i++;
  return i;
}

/** End of an unquoted plain value: the first whitespace, `&`, `#` (or EOL). A quote inside it is part of the value. */
function valueEnd(s: string, from: number, stops: string): number {
  let i = from;
  while (i < s.length && !isEol(s[i]) && !stops.includes(s[i])) i++;
  return i;
}

/**
 * End of an unquoted value whose key was a JSON string (`"password":123,`): ends at `,` `}` `]`, whitespace,
 * EOL, or a backslash that starts an escaped quote (`\"`), so the JSON structure around it survives.
 */
function jsonValueEnd(s: string, from: number): number {
  let i = from;
  while (i < s.length) {
    const c = s[i];
    if (isEol(c) || isBlank(c) || c === "," || c === "}" || c === "]") break;
    if (c === "\\") {
      let j = i;
      while (s[j] === "\\") j++;
      if (s[j] === '"' || s[j] === "'") break;
      i = j;
      continue;
    }
    i++;
  }
  return i;
}

/**
 * Index of the closing `quote` of a quoted value that was opened after `backslashes` escape characters
 * (`"…"` → 0, `\"…\"` inside one level of serialized JSON → 1, `\\\"…\\\"` → 3). The closer is the same
 * number of backslashes followed by `quote`; a run of another length is an escape inside the value. Returns
 * the index of the closer's first backslash, or -1 when the quote is not closed on this line. Linear.
 */
function closingQuote(s: string, from: number, quote: string, backslashes: number): number {
  let j = from;
  while (j < s.length) {
    const c = s[j];
    if (isEol(c)) return -1;
    if (c === "\\") {
      let e = j;
      while (s[e] === "\\") e++;
      if (s[e] === quote) {
        if (e - j === backslashes) return j;
        j = e + 1; // an escaped quote inside the value
        continue;
      }
      j = e;
      continue;
    }
    if (c === quote && backslashes === 0) return j;
    j++;
  }
  return -1;
}

/** An auth scheme word at `i` (`Bearer `, `Digest `): where its credential starts, and whether it is a multi-parameter scheme. */
function schemeAt(s: string, i: number): { start: number; digest: boolean } | null {
  for (const scheme of AUTH_SCHEMES) {
    if (s.slice(i, i + scheme.length).toLowerCase() === scheme && isBlank(s[i + scheme.length])) {
      return { start: skipBlanks(s, i + scheme.length), digest: scheme === "digest" };
    }
  }
  return null;
}

/**
 * Masks the value of every secret-named pair. The credential is masked, the key and separator stay, and an
 * auth scheme stays visible (`authorization=Bearer ***`).
 *
 * - A quote opens a quoted value only as the first character after the separator (after blanks and any
 *   escape backslashes). Inside it the value runs to the matching quote, escapes respected, and that quote
 *   is kept; structure around the value survives. `password="x"` → `password="***"`.
 * - Otherwise the value is unquoted and a quote in it is part of the secret: `password=ab"S"` → `password=***`.
 *   An unquoted value ends at whitespace, `&`, `#`; a comma belongs to the secret (`password=ab,cd` → `password=***`).
 * - A key written as a JSON string (`"password":`, `\"password\":`, nested `\\\"password\\\":`) switches the
 *   unquoted value to JSON rules: it ends at `,` `}` `]`, whitespace or an escaped quote, so
 *   `{"password":123,"user":"bob"}` → `{"password":***,"user":"bob"}`.
 * - A `:` header (`Authorization: …`, `Cookie: …`) and a Digest credential run to the end of the line.
 */
export function redactSecretPairs(text: string): string {
  let out = "";
  let last = 0;
  let i = 0;
  while (i < text.length) {
    const sep = text[i];
    if (sep !== "=" && sep !== ":") {
      i++;
      continue;
    }
    // The key ends before blanks and before a closing quote, which may be escaped (`\"password\" :`).
    let keyEnd = i;
    while (keyEnd > 0 && isBlank(text[keyEnd - 1])) keyEnd--;
    let jsonKey = false;
    if (keyEnd > 0 && (text[keyEnd - 1] === '"' || text[keyEnd - 1] === "'")) {
      jsonKey = true;
      keyEnd--;
      while (keyEnd > 0 && text[keyEnd - 1] === "\\") keyEnd--;
    }
    let k = keyEnd;
    while (k > 0 && isKeyCode(text.charCodeAt(k - 1))) k--;
    const name = text.slice(k, keyEnd);
    if (name.length === 0 || !isSensitiveKeyName(name)) {
      i++;
      continue;
    }
    // Value: blanks, then optional escape backslashes, then a quote that opens a quoted value.
    const v = skipBlanks(text, i + 1);
    let b = 0;
    while (text[v + b] === "\\") b++;
    const quote = text[v + b];
    if (quote === '"' || quote === "'") {
      const contentStart = v + b + 1;
      const close = closingQuote(text, contentStart, quote, b);
      const end = close === -1 ? lineEnd(text, contentStart) : close;
      const scheme = schemeAt(text, contentStart);
      const valueStart = scheme === null || scheme.start > end ? contentStart : scheme.start;
      out += text.slice(last, valueStart) + "***";
      last = end;
      i = end;
      continue;
    }
    const scheme = jsonKey ? null : schemeAt(text, v);
    const valueStart = scheme === null ? v : scheme.start;
    let end: number;
    if (jsonKey) end = jsonValueEnd(text, v);
    else if (sep === ":" && (isLineValueName(name) || scheme !== null)) end = lineEnd(text, valueStart); // header: the whole line
    else if (scheme?.digest) end = valueEnd(text, valueStart, "&#"); // Digest: quoted parameters, to end of URL / line
    else end = valueEnd(text, valueStart, " \t&#");
    out += text.slice(last, valueStart) + "***";
    last = end;
    i = end;
  }
  return out + text.slice(last);
}

/** Scrub credentials from arbitrary diagnostic text, including encoded URLs. */
export function redact(text: string): string {
  const stage1 = redactSecretPairs(
    text
      .replace(/\/account\/confirm-email\?[^\s"'<>#]*/gi, url => url.replace(/((?:\?|&amp;|&)(?:t|c)=)[^&#\s"']*/gi, "$1***"))
      .replace(/(?:%2f|\/)account(?:%2f|\/)confirm-email%3f(?:(?!%23)[^\s"'<>#])*/gi, url => url.replace(/((?:%3f|%26)(?:t|c)%3d)(?:(?!%26|%23)[^&#\s"'])*/gi, "$1***")),
  );
  // The last two steps are hand-written linear scans (lib/linear-text.ts): their regex forms were
  // O(n²) on "%23%23%23…" / "aaaa…" in the arbitrary text this function is fed.
  return redactUrlUserinfo(redactEncodedParamValues(stage1));
}

/** Bound diagnostic copies; never expand arbitrary class instances or large graphs. */
export function redactValue(value: unknown): unknown {
  const seen = new WeakSet<object>();
  let remaining = 1000;
  function visit(v: unknown, depth: number): unknown {
    if (--remaining < 0 || depth > 12) return "[Truncated]";
    if (typeof v === "string") return redact(v);
    if (!v || typeof v !== "object") return v;
    const error = v instanceof Error;
    if (!error && !Array.isArray(v) && Object.getPrototypeOf(v) !== Object.prototype && Object.getPrototypeOf(v) !== null) return v;
    if (seen.has(v)) return "[Circular]";
    seen.add(v);
    try {
      if (Array.isArray(v)) return v.slice(0, Math.max(0, remaining)).map(x => visit(x, depth + 1));
      const out = error ? Object.create(Object.getPrototypeOf(v)) as Error : Object.create(null);
      for (const key of Object.getOwnPropertyNames(v)) {
        if (remaining <= 0) { Object.defineProperty(out, "_truncated", { value: true, enumerable: true }); break; }
        const descriptor = Object.getOwnPropertyDescriptor(v, key)!;
        if (!("value" in descriptor)) continue;
        // A property named like a secret is masked whole, whatever its value looks like (`{ password: "…" }`).
        const masked = isSensitiveKeyName(key) && descriptor.value !== null && descriptor.value !== undefined;
        Object.defineProperty(out, key, { ...descriptor, value: masked ? "***" : visit(descriptor.value, depth + 1) });
      }
      return out;
    } finally { seen.delete(v); }
  }
  return visit(value, 0);
}
