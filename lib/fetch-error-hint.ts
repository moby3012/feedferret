/**
 * Capability hint for a failed fetch, from the HTTP status our SSRF fetch
 * puts in its error ("Fetch failed: 429 …") — never from arbitrary digits.
 */
export function hintForFetchError(err: unknown): "rate-limited" | "blocked" | undefined {
  const status = /^Fetch failed: (\d{3})\b/.exec(err instanceof Error ? err.message : String(err))?.[1];
  if (status === "429") return "rate-limited";
  if (status === "401" || status === "403") return "blocked";
  return undefined;
}
