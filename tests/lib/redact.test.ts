import { expect, it } from "vitest";
import { redact, redactValue } from "../../lib/redact";
import { sanitizeDigestSummary } from "../../lib/ai/citations";
it("scrubs URL credentials and all sensitive query names", () => {
  for (const key of ["key", "token", "access_key", "api_key", "apikey", "password", "secret", "TOKEN"]) {
    expect(redact(`failed https://user:pass@example.com/rss?${key}=hidden&ok=yes`)).toBe(`failed https://***@example.com/rss?${key}=***&ok=yes`);
  }
  expect(JSON.stringify(redactValue({ error: new Error("https://a.test/?key=hidden") }))).not.toContain("hidden");
});
it("preserves technology names while defanging hosts", () => {
  expect(sanitizeDigestSummary("Node.js and Vue.js visit evil.com")).toContain("Node.js and Vue.js");
  expect(sanitizeDigestSummary("visit evil.com")).toContain("evil[.]com");
});
