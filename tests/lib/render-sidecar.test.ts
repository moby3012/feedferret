import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { extractHtmlFromSidecarResponse, renderWithConfig } from "../../lib/render-sidecar";

// ── extractHtmlFromSidecarResponse (pure) ────────────────────────────────────

describe("extractHtmlFromSidecarResponse", () => {
  it("returns a raw text/html body as-is", () => {
    const html = "<html><body><article>hi</article></body></html>";
    expect(extractHtmlFromSidecarResponse("text/html; charset=utf-8", html)).toBe(html);
  });

  it("returns null for an empty body", () => {
    expect(extractHtmlFromSidecarResponse("text/html", "   ")).toBeNull();
  });

  it("pulls `html` from a JSON envelope", () => {
    const body = JSON.stringify({ html: "<p>rendered</p>" });
    expect(extractHtmlFromSidecarResponse("application/json", body)).toBe("<p>rendered</p>");
  });

  it("prefers html over content/cleaned_html/markdown", () => {
    const body = JSON.stringify({ markdown: "# md", content: "<p>c</p>", html: "<p>h</p>" });
    expect(extractHtmlFromSidecarResponse("application/json", body)).toBe("<p>h</p>");
  });

  it("falls back to content, then cleaned_html, then markdown", () => {
    expect(extractHtmlFromSidecarResponse("application/json", JSON.stringify({ content: "<p>c</p>" }))).toBe("<p>c</p>");
    expect(extractHtmlFromSidecarResponse("application/json", JSON.stringify({ cleaned_html: "<p>cl</p>" }))).toBe("<p>cl</p>");
    expect(extractHtmlFromSidecarResponse("application/json", JSON.stringify({ markdown: "# md" }))).toBe("# md");
  });

  it("reads crawl4ai-style results[0].html", () => {
    const body = JSON.stringify({ results: [{ html: "<p>from results</p>" }] });
    expect(extractHtmlFromSidecarResponse("application/json", body)).toBe("<p>from results</p>");
  });

  it("reads a nested `result` object", () => {
    const body = JSON.stringify({ result: { cleaned_html: "<p>nested</p>" } });
    expect(extractHtmlFromSidecarResponse("application/json", body)).toBe("<p>nested</p>");
  });

  it("returns null for JSON without a usable field", () => {
    expect(extractHtmlFromSidecarResponse("application/json", JSON.stringify({ status: "ok" }))).toBeNull();
  });

  it("returns null for malformed JSON", () => {
    expect(extractHtmlFromSidecarResponse("application/json", "{not json")).toBeNull();
  });
});

// ── renderWithConfig (mocked fetch + SSRF) ───────────────────────────────────

// Stub the SSRF layer so we don't touch DNS or the database in unit tests.
vi.mock("../../lib/ssrf", () => ({
  assertSafeFetchUrl: vi.fn(async (u: string) => new URL(u)),
  isTrustedFeedFetchingAllowed: vi.fn(async () => false),
}));

describe("renderWithConfig", () => {
  const config = { url: "http://sidecar.internal/crawl", token: "secret-token" };
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.clearAllMocks();
  });

  function jsonResponse(payload: unknown) {
    return {
      ok: true,
      headers: { get: (k: string) => (k.toLowerCase() === "content-type" ? "application/json" : null) },
      arrayBuffer: async () => new TextEncoder().encode(JSON.stringify(payload)).buffer,
    };
  }

  it("POSTs the target url and returns rendered html, sending the bearer token", async () => {
    fetchMock.mockResolvedValue(jsonResponse({ html: "<p>rendered page</p>" }));
    const html = await renderWithConfig(config, "https://client-only.example/blog");
    expect(html).toBe("<p>rendered page</p>");

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [calledUrl, init] = fetchMock.mock.calls[0];
    expect(calledUrl).toBe(config.url);
    expect(init.method).toBe("POST");
    expect(JSON.parse(init.body)).toEqual({ url: "https://client-only.example/blog" });
    expect(init.headers.authorization).toBe("Bearer secret-token");
  });

  it("omits the Authorization header when no token is set", async () => {
    fetchMock.mockResolvedValue(jsonResponse({ html: "<p>x</p>" }));
    await renderWithConfig({ url: config.url, token: null }, "https://example.com/");
    const init = fetchMock.mock.calls[0][1];
    expect(init.headers.authorization).toBeUndefined();
  });

  it("returns null on a non-ok sidecar response", async () => {
    fetchMock.mockResolvedValue({
      ok: false,
      headers: { get: () => null },
      arrayBuffer: async () => new ArrayBuffer(0),
    });
    expect(await renderWithConfig(config, "https://example.com/")).toBeNull();
  });

  it("returns null (never throws) when fetch rejects", async () => {
    fetchMock.mockRejectedValue(new Error("network down"));
    expect(await renderWithConfig(config, "https://example.com/")).toBeNull();
  });

  it("returns null when the response exceeds the size cap", async () => {
    const big = "x".repeat(200);
    fetchMock.mockResolvedValue({
      ok: true,
      headers: { get: () => "text/html" },
      arrayBuffer: async () => new TextEncoder().encode(big).buffer,
    });
    expect(await renderWithConfig(config, "https://example.com/", { maxBytes: 50 })).toBeNull();
  });
});
