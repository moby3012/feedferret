import { describe, it, expect, vi } from "vitest";

// Isolated from readability-extract.test.ts and the extractus-tier test file:
// vitest module mocks are file-scoped, so mocking the SSRF fetch + every
// in-process extraction tier here can't affect those files' own (real) tests.
vi.mock("../../lib/ssrf", () => ({
  fetchTextWithSsrfProtection: vi.fn(async () => "<html><head><title>Thin</title></head><body><p>x</p></body></html>"),
  isTrustedFeedFetchingAllowed: vi.fn(async () => false),
}));
vi.mock("../../lib/render-sidecar", () => ({ renderViaSidecar: vi.fn(async () => null) }));
vi.mock("../../lib/hosted-fetch", () => ({
  fetchViaHostedApiDetailed: vi.fn(),
  getHostedFetchConfigForUser: vi.fn(async () => null),
  HostedFetchRateLimitedError: class extends Error {},
}));
vi.mock("defuddle", () => ({
  default: class {
    parse() {
      return null;
    }
  },
}));
vi.mock("@mozilla/readability", () => ({
  Readability: class {
    parse() {
      return null;
    }
  },
}));
vi.mock("@extractus/article-extractor", () => ({ extractFromHtml: vi.fn(async () => null) }));

const AI_EXTRACTED_MARKDOWN =
  "# AI Extracted Title\n\nThis is the full article body text as pulled out by the model, long enough to clear the minimum-length guard that every extraction tier applies before it's trusted.";

vi.mock("../../lib/ai-extraction", () => ({
  extractArticleWithAi: vi.fn(async () => ({ title: "AI Extracted Title", content: AI_EXTRACTED_MARKDOWN })),
}));

describe("fetchAndExtractReadable — M6 AI-extraction fallback tier", () => {
  it("uses the AI-extraction result when every in-process tier fails and aiExtraction is provided", async () => {
    const { fetchAndExtractReadable } = await import("../../lib/readability-extract");
    const result = await fetchAndExtractReadable("https://example.com/thin-article", {
      aiExtraction: { provider: "openai", apiKey: "test-key" },
    });
    expect(result.extractedBy).toBe("ai");
    expect(result.title).toBe("AI Extracted Title");
    expect(result.markdown).toContain("full article body text");
    expect(result.html).toContain("full article body text");
  });

  it("does not attempt AI extraction when aiExtraction is not provided (falls through to 'none')", async () => {
    const { fetchAndExtractReadable } = await import("../../lib/readability-extract");
    const { extractArticleWithAi } = await import("../../lib/ai-extraction");
    vi.mocked(extractArticleWithAi).mockClear();

    const result = await fetchAndExtractReadable("https://example.com/thin-article-2");
    expect(result.extractedBy).toBe("none");
    expect(extractArticleWithAi).not.toHaveBeenCalled();
  });
});
