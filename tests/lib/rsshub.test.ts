import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

vi.mock("../../lib/ssrf", () => ({
  assertSafeFetchUrl: vi.fn(async (u: string) => new URL(u)),
  isTrustedFeedFetchingAllowed: vi.fn(async () => false),
}));

vi.mock("../../lib/feed-fetcher", () => ({
  fetchFeedArticles: vi.fn(),
}));

import {
  buildRsshubRouteUrl,
  validateRsshubRoute,
  buildRoutePrompt,
  parseRouteProposal,
  proposeAndValidateRoute,
  type RsshubConfig,
} from "../../lib/rsshub";
import { fetchFeedArticles } from "../../lib/feed-fetcher";
import type { AiConfig } from "../../lib/ai-summary";

describe("buildRsshubRouteUrl", () => {
  it("joins the base URL and route path", () => {
    const config: RsshubConfig = { baseUrl: "http://rsshub.internal:1200", apiKey: null };
    expect(buildRsshubRouteUrl(config, "/youtube/channel/UC123")).toBe(
      "http://rsshub.internal:1200/youtube/channel/UC123",
    );
  });

  it("strips a trailing slash on the base URL and adds a leading slash on the route", () => {
    const config: RsshubConfig = { baseUrl: "http://rsshub.internal:1200/", apiKey: null };
    expect(buildRsshubRouteUrl(config, "reddit/subreddit/selfhosted")).toBe(
      "http://rsshub.internal:1200/reddit/subreddit/selfhosted",
    );
  });

  it("appends the access key as a query parameter when configured", () => {
    const config: RsshubConfig = { baseUrl: "http://rsshub.internal:1200", apiKey: "secret" };
    expect(buildRsshubRouteUrl(config, "/github/repos/DIYgod/RSSHub/releases")).toBe(
      "http://rsshub.internal:1200/github/repos/DIYgod/RSSHub/releases?key=secret",
    );
  });
});

describe("validateRsshubRoute", () => {
  const config: RsshubConfig = { baseUrl: "http://rsshub.internal:1200", apiKey: null };

  it("returns ok with feed metadata when the route resolves to a real feed", async () => {
    vi.mocked(fetchFeedArticles).mockResolvedValueOnce({
      title: "My Channel",
      articles: [{ title: "Video 1", link: "https://x", content: "" }, { title: "Video 2", link: "https://y", content: "" }],
    } as any);

    const result = await validateRsshubRoute(config, "/youtube/channel/UC123");
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.title).toBe("My Channel");
      expect(result.itemCount).toBe(2);
      expect(result.sampleTitles).toEqual(["Video 1", "Video 2"]);
    }
  });

  it("returns not-ok when the feed has no items", async () => {
    vi.mocked(fetchFeedArticles).mockResolvedValueOnce({ title: "Empty", articles: [] } as any);
    const result = await validateRsshubRoute(config, "/youtube/channel/bogus");
    expect(result.ok).toBe(false);
  });

  it("returns not-ok (never throws) when fetching/parsing the route fails", async () => {
    vi.mocked(fetchFeedArticles).mockRejectedValueOnce(new Error("Not Found"));
    const result = await validateRsshubRoute(config, "/nonexistent/route");
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toContain("Not Found");
  });
});

describe("buildRoutePrompt", () => {
  it("includes the source description and asks for strict JSON", () => {
    const prompt = buildRoutePrompt("the YouTube channel https://youtube.com/@example");
    expect(prompt).toContain("https://youtube.com/@example");
    expect(prompt).toContain("STRICT JSON");
    expect(prompt).toContain("rsshub.app");
  });
});

describe("parseRouteProposal", () => {
  it("parses a plain JSON object with a route", () => {
    expect(parseRouteProposal('{"route":"/youtube/channel/UC123"}')).toBe("/youtube/channel/UC123");
  });

  it("tolerates markdown code fences and surrounding prose", () => {
    const raw = 'Here you go:\n```json\n{"route":"/reddit/subreddit/selfhosted"}\n```\n';
    expect(parseRouteProposal(raw)).toBe("/reddit/subreddit/selfhosted");
  });

  it("returns null when the model reports it couldn't determine a route", () => {
    expect(parseRouteProposal('{"route":null}')).toBeNull();
  });

  it("returns null for unparseable input or a route not starting with '/'", () => {
    expect(parseRouteProposal("not json")).toBeNull();
    expect(parseRouteProposal('{"route":"youtube/channel/UC123"}')).toBeNull();
    expect(parseRouteProposal("")).toBeNull();
  });
});

describe("proposeAndValidateRoute", () => {
  const aiConfig: AiConfig = { provider: "openai", apiKey: "test-key" };
  const rsshubConfig: RsshubConfig = { baseUrl: "http://rsshub.internal:1200", apiKey: null };
  const originalFetch = global.fetch;

  afterEach(() => {
    global.fetch = originalFetch;
  });

  it("proposes a route via AI and validates it", async () => {
    global.fetch = vi.fn(async () => ({
      ok: true,
      json: async () => ({ choices: [{ message: { content: '{"route":"/youtube/channel/UC123"}' } }] }),
    })) as unknown as typeof fetch;
    vi.mocked(fetchFeedArticles).mockResolvedValueOnce({
      title: "My Channel",
      articles: [{ title: "Video 1", link: "https://x", content: "" }],
    } as any);

    const result = await proposeAndValidateRoute("https://youtube.com/@example", aiConfig, rsshubConfig);
    expect(result).not.toBeNull();
    expect(result!.route).toBe("/youtube/channel/UC123");
    expect(result!.validation.ok).toBe(true);
  });

  it("returns null when the AI can't confidently propose a route", async () => {
    global.fetch = vi.fn(async () => ({
      ok: true,
      json: async () => ({ choices: [{ message: { content: '{"route":null}' } }] }),
    })) as unknown as typeof fetch;

    const result = await proposeAndValidateRoute("a vague description of nothing in particular", aiConfig, rsshubConfig);
    expect(result).toBeNull();
  });
});
