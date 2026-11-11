/** Scrub credentials from arbitrary diagnostic text, including malformed URLs. */
export function redact(text: string): string {
  return text
    .replace(/([?&](?:key|token|access_key|api_key|apikey|password|secret)=)[^&#\s"'<>]*/gi, "$1***")
    .replace(/(https?:\/\/)[^\s/@]+@/gi, "$1***@");
}

export function redactValue(value: unknown, seen = new WeakSet<object>()): unknown {
  if (typeof value === "string") return redact(value);
  if (value instanceof Error) return redact(value.stack ?? String(value));
  if (!value || typeof value !== "object") return value;
  if (seen.has(value)) return "[Circular]";
  seen.add(value);
  if (Array.isArray(value)) return value.map(v => redactValue(v, seen));
  return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, redactValue(v, seen)]));
}
