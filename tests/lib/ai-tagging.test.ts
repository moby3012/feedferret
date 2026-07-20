import { describe, it, expect, vi } from "vitest";
import { buildTaggingPrompt, parseAiTags, generateTags } from "../../lib/ai-tagging";
import type { AiConfig } from "../../lib/ai-summary";

describe("buildTaggingPrompt", () => {
  it("includes the article content and asks for strict JSON", () => {
    const prompt = buildTaggingPrompt("<p>An article about lighthouses.</p>");
    expect(prompt).toContain("lighthouses");
    expect(prompt).toContain("STRICT JSON");
    expect(prompt).not.toContain("Prefer reusing");
  });

  it("hints at reusing existing labels when some are provided", () => {
    const prompt = buildTaggingPrompt("content", ["Tech", "Politics"]);
    expect(prompt).toContain("Prefer reusing");
    expect(prompt).toContain("Tech, Politics");
  });
});

describe("parseAiTags", () => {
  it("parses a plain JSON array", () => {
    expect(parseAiTags('["Politics","Elections"]')).toEqual(["Politics", "Elections"]);
  });

  it("tolerates markdown code fences and surrounding prose", () => {
    const raw = 'Sure, here are the tags:\n```json\n["AI", "Robotics"]\n```\nHope that helps!';
    expect(parseAiTags(raw)).toEqual(["AI", "Robotics"]);
  });

  it("returns [] for unparseable or non-array input", () => {
    expect(parseAiTags("not json at all")).toEqual([]);
    expect(parseAiTags('{"not":"an array"}')).toEqual([]);
    expect(parseAiTags("")).toEqual([]);
  });

  it("deduplicates case-insensitively and caps at 4 tags", () => {
    const raw = '["Tech", "tech", "A", "B", "C", "D", "E"]';
    const tags = parseAiTags(raw);
    expect(tags).toEqual(["Tech", "A", "B", "C"]);
  });

  it("drops non-string entries and trims/bounds tag length", () => {
    const longTag = "x".repeat(100);
    const raw = JSON.stringify([42, "  Spaced  ", longTag, null]);
    const tags = parseAiTags(raw);
    expect(tags).toContain("Spaced");
    expect(tags.some((t) => t.length > 40)).toBe(false);
  });
});

describe("generateTags", () => {
  it("calls the AI provider and returns parsed tags", async () => {
    const config: AiConfig = { provider: "openai", apiKey: "test-key" };
    const originalFetch = global.fetch;
    global.fetch = vi.fn(async () => ({
      ok: true,
      json: async () => ({ choices: [{ message: { content: '["Science", "Space"]' } }] }),
    })) as unknown as typeof fetch;

    try {
      const tags = await generateTags("An article about a rocket launch.", config);
      expect(tags).toEqual(["Science", "Space"]);
    } finally {
      global.fetch = originalFetch;
    }
  });
});
