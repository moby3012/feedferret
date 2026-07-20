import { describe, it, expect, vi } from "vitest";
import { buildExtractionPrompt, parseAiExtraction, extractArticleWithAi } from "../../lib/ai-extraction";
import type { AiConfig } from "../../lib/ai-summary";

describe("buildExtractionPrompt", () => {
  it("includes the URL and the reduced page HTML, and asks for strict JSON", () => {
    const prompt = buildExtractionPrompt("<article><p>Lighthouses guide ships.</p></article>", "https://example.com/a");
    expect(prompt).toContain("https://example.com/a");
    expect(prompt).toContain("Lighthouses guide ships");
    expect(prompt).toContain("STRICT JSON");
  });
});

describe("parseAiExtraction", () => {
  it("parses a plain JSON object", () => {
    expect(parseAiExtraction('{"title":"Hello","content":"Body text"}')).toEqual({
      title: "Hello",
      content: "Body text",
    });
  });

  it("tolerates markdown code fences and surrounding prose", () => {
    const raw = 'Sure, here it is:\n```json\n{"title":"T","content":"C"}\n```\nDone.';
    expect(parseAiExtraction(raw)).toEqual({ title: "T", content: "C" });
  });

  it("returns null for unparseable input or missing content", () => {
    expect(parseAiExtraction("not json")).toBeNull();
    expect(parseAiExtraction('{"title":"only a title"}')).toBeNull();
    expect(parseAiExtraction("")).toBeNull();
  });

  it("normalizes a null/empty title to null", () => {
    expect(parseAiExtraction('{"title":null,"content":""}')).toEqual({ title: null, content: "" });
    expect(parseAiExtraction('{"title":"  ","content":"x"}')).toEqual({ title: null, content: "x" });
  });
});

describe("extractArticleWithAi", () => {
  const config: AiConfig = { provider: "openai", apiKey: "test-key" };

  it("returns the parsed extraction when the model finds a real article", async () => {
    const originalFetch = global.fetch;
    global.fetch = vi.fn(async () => ({
      ok: true,
      json: async () => ({
        choices: [
          {
            message: {
              content: JSON.stringify({
                title: "A Real Article",
                content:
                  "This is a long enough article body to pass the minimum extracted-text-length guard used by every tier in the waterfall, since it needs to clear at least two hundred characters of plain text before it is trusted as a real extraction result rather than a hallucinated wisp of nothing.",
              }),
            },
          },
        ],
      }),
    })) as unknown as typeof fetch;

    try {
      const result = await extractArticleWithAi("<html>...</html>", "https://example.com/a", config);
      expect(result).toEqual({
        title: "A Real Article",
        content:
          "This is a long enough article body to pass the minimum extracted-text-length guard used by every tier in the waterfall, since it needs to clear at least two hundred characters of plain text before it is trusted as a real extraction result rather than a hallucinated wisp of nothing.",
      });
    } finally {
      global.fetch = originalFetch;
    }
  });

  it("returns null when the model reports no article found", async () => {
    const originalFetch = global.fetch;
    global.fetch = vi.fn(async () => ({
      ok: true,
      json: async () => ({ choices: [{ message: { content: '{"title":null,"content":""}' } }] }),
    })) as unknown as typeof fetch;

    try {
      const result = await extractArticleWithAi("<html>...</html>", "https://example.com/empty", config);
      expect(result).toBeNull();
    } finally {
      global.fetch = originalFetch;
    }
  });

  it("returns null (never throws) when the provider call fails", async () => {
    const originalFetch = global.fetch;
    global.fetch = vi.fn(async () => ({
      ok: false,
      status: 500,
      text: async () => "internal error",
    })) as unknown as typeof fetch;

    try {
      const result = await extractArticleWithAi("<html>...</html>", "https://example.com/a", config);
      expect(result).toBeNull();
    } finally {
      global.fetch = originalFetch;
    }
  });
});
