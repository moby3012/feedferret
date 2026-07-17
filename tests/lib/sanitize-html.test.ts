import { describe, it, expect } from "vitest";
import { getSanitizer } from "../../lib/sanitize-html";

describe("getSanitizer", () => {
  it("forces rel=noopener noreferrer on any link that keeps a target attribute", async () => {
    const DOMPurify = await getSanitizer();
    const clean = DOMPurify.sanitize('<a target="_blank" href="x">y</a>', { ADD_ATTR: ["target", "rel"] });
    expect(clean).toContain('rel="noopener noreferrer"');
  });
});
