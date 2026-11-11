import { expect, it } from "vitest";
import { sanitizeDigestSummary } from "../../lib/ai/citations";
it("preserves technology names while defanging hosts", () => {
  expect(sanitizeDigestSummary("Node.js and Vue.js visit evil.com")).toContain("Node.js and Vue.js");
  expect(sanitizeDigestSummary("visit evil.com")).toContain("evil[.]com");
});
it("preserves generic JS names but defangs nested hosts", () => {
  expect(sanitizeDigestSummary("Express.js Three.js D3.js")).toBe("Express.js Three.js D3.js");
  expect(sanitizeDigestSummary("evil.node.js node.js.evil.com")).toBe("evil[.]node[.]js node[.]js[.]evil[.]com");
});
