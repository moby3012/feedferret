/** Scrub credentials from arbitrary diagnostic text, including encoded URLs. */
export function redact(text: string): string {
  return text
    .replace(/\/account\/confirm-email\?[^\s"'<>#]*/gi, url => url.replace(/((?:\?|&amp;|&)(?:t|c)=)[^&#\s"']*/gi, "$1***"))
    .replace(/(?:%2f|\/)account(?:%2f|\/)confirm-email%3f(?:(?!%23)[^\s"'<>#])*/gi, url => url.replace(/((?:%3f|%26)(?:t|c)%3d)(?:(?!%26|%23)[^&#\s"'])*/gi, "$1***"))
    .replace(/((?:[?&#;]|&amp;)[\w.-]*(?:key|token|secret|passw(?:or)?d|pwd|auth|sig(?:nature)?)=)[^&#\s"']*/gi, "$1***")
    .replace(/((?:%3f|%26|%23|%3b)(?:[\w.-]|%[0-9a-f]{2})*?(?:key|token|secret|passw(?:or)?d|pwd|auth|sig(?:nature)?)%3d)(?:(?!%26|%23|%3b)[^&#\s"'])*/gi, "$1***")
    .replace(/([a-z][a-z0-9+.-]*:\/\/)[^\s/?#]+@/gi, "$1***@");
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
