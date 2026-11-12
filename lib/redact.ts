import { redactEncodedParamValues, redactUrlUserinfo } from "@/lib/linear-text";

// Secret-looking `name=value` pairs anywhere in text (query strings, log lines, `key=value` fragments).
// The key is the whole `[\w.-]` run before "=", so `x-api-key`, `access_token`, `apikey` match by suffix;
// the lookbehind pins each match to the run start, which keeps the scan linear (no re-scan per character).
// An auth scheme after the separator (`authorization=Bearer xyz`) stays visible, the credential does not.
const SECRET_PAIR_RE = /((?<![\w.-])[\w.-]*(?:key|token|secret|passw(?:or)?d|pwd|auth|authorization|sig(?:nature)?)=(?:(?:bearer|basic|digest|negotiate|token)[ \t]+)?)[^&#\s"',]*/gi;
// `Authorization: Basic xyz` / `Proxy-Authorization:Bearer xyz` as written in headers and log text.
const AUTH_HEADER_RE = /((?<![\w.-])[\w.-]*auth(?:orization)?:[ \t]*(?:(?:bearer|basic|digest|negotiate|token)[ \t]+)?)[^&#\s"',]*/gi;

/** Scrub credentials from arbitrary diagnostic text, including encoded URLs. */
export function redact(text: string): string {
  const stage1 = text
    .replace(/\/account\/confirm-email\?[^\s"'<>#]*/gi, url => url.replace(/((?:\?|&amp;|&)(?:t|c)=)[^&#\s"']*/gi, "$1***"))
    .replace(/(?:%2f|\/)account(?:%2f|\/)confirm-email%3f(?:(?!%23)[^\s"'<>#])*/gi, url => url.replace(/((?:%3f|%26)(?:t|c)%3d)(?:(?!%26|%23)[^&#\s"'])*/gi, "$1***"))
    .replace(SECRET_PAIR_RE, "$1***")
    .replace(AUTH_HEADER_RE, "$1***");
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
        Object.defineProperty(out, key, { ...descriptor, value: visit(descriptor.value, depth + 1) });
      }
      return out;
    } finally { seen.delete(v); }
  }
  return visit(value, 0);
}
