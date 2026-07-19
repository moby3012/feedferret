import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { fetchViaHostedApi } from "../../lib/hosted-fetch";

// ── getHostedFetchConfigForUser — resilience + resolution ────────────────────

describe("getHostedFetchConfigForUser", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.doUnmock("../../lib/db");
    vi.doUnmock("../../lib/crypto");
  });

  it("returns null (never throws) when the settings query fails", async () => {
    vi.doMock("../../lib/db", () => ({
      db: { user: { findUnique: vi.fn().mockRejectedValue(new Error("db down")) } },
    }));
    const { getHostedFetchConfigForUser: fresh } = await import("../../lib/hosted-fetch");
    await expect(fresh("user-1")).resolves.toBeNull();
  });

  it("returns null when no provider/key is configured", async () => {
    vi.doMock("../../lib/db", () => ({
      db: { user: { findUnique: vi.fn().mockResolvedValue({ contentFetchProvider: null, contentFetchApiKey: null }) } },
    }));
    const { getHostedFetchConfigForUser: fresh } = await import("../../lib/hosted-fetch");
    await expect(fresh("user-1")).resolves.toBeNull();
  });

  it("returns a decrypted config when both provider and key are set", async () => {
    vi.doMock("../../lib/db", () => ({
      db: {
        user: {
          findUnique: vi.fn().mockResolvedValue({ contentFetchProvider: "jina", contentFetchApiKey: "encrypted-blob" }),
        },
      },
    }));
    vi.doMock("../../lib/crypto", () => ({ decryptIfValue: () => "decrypted-key" }));
    const { getHostedFetchConfigForUser: fresh } = await import("../../lib/hosted-fetch");
    await expect(fresh("user-1")).resolves.toEqual({ provider: "jina", apiKey: "decrypted-key" });
  });

  it("returns null for an unrecognized provider value", async () => {
    vi.doMock("../../lib/db", () => ({
      db: {
        user: {
          findUnique: vi.fn().mockResolvedValue({ contentFetchProvider: "carrier-pigeon", contentFetchApiKey: "x" }),
        },
      },
    }));
    vi.doMock("../../lib/crypto", () => ({ decryptIfValue: () => "k" }));
    const { getHostedFetchConfigForUser: fresh } = await import("../../lib/hosted-fetch");
    await expect(fresh("user-1")).resolves.toBeNull();
  });
});

// Stub the SSRF layer so we don't touch DNS in unit tests.
vi.mock("../../lib/ssrf", () => ({
  assertSafeFetchUrl: vi.fn(async (u: string) => new URL(u)),
  isTrustedFeedFetchingAllowed: vi.fn(async () => false),
}));

describe("fetchViaHostedApi", () => {
  const targetUrl = "https://client-only.example/blog/post";
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.clearAllMocks();
  });

  function jsonResponse(payload: unknown, ok = true) {
    return {
      ok,
      arrayBuffer: async () => new TextEncoder().encode(JSON.stringify(payload)).buffer,
    };
  }

  describe("jina provider", () => {
    it("GETs r.jina.ai with the target URL and bearer token, parsing data.content/title", async () => {
      fetchMock.mockResolvedValue(jsonResponse({ data: { title: "A Title", content: "# Clean markdown\n\nBody." } }));

      const result = await fetchViaHostedApi(targetUrl, { provider: "jina", apiKey: "jina-key" });
      expect(result).toEqual({ content: "# Clean markdown\n\nBody.", title: "A Title" });

      expect(fetchMock).toHaveBeenCalledTimes(1);
      const [calledUrl, init] = fetchMock.mock.calls[0];
      expect(calledUrl).toBe(`https://r.jina.ai/${targetUrl}`);
      expect(init.headers.authorization).toBe("Bearer jina-key");
    });

    it("returns null when jina responds non-ok", async () => {
      fetchMock.mockResolvedValue(jsonResponse({}, false));
      const result = await fetchViaHostedApi(targetUrl, { provider: "jina", apiKey: "k" });
      expect(result).toBeNull();
    });

    it("returns null when content is missing/blank", async () => {
      fetchMock.mockResolvedValue(jsonResponse({ data: { title: "T", content: "   " } }));
      const result = await fetchViaHostedApi(targetUrl, { provider: "jina", apiKey: "k" });
      expect(result).toBeNull();
    });

    it("returns title:null when the provider sends no title", async () => {
      fetchMock.mockResolvedValue(jsonResponse({ data: { content: "body text" } }));
      const result = await fetchViaHostedApi(targetUrl, { provider: "jina", apiKey: "k" });
      expect(result).toEqual({ content: "body text", title: null });
    });
  });

  describe("firecrawl provider", () => {
    it("POSTs api.firecrawl.dev/v1/scrape with the url + markdown format and bearer token", async () => {
      fetchMock.mockResolvedValue(
        jsonResponse({ success: true, data: { markdown: "# Firecrawl body", metadata: { title: "FC Title" } } }),
      );

      const result = await fetchViaHostedApi(targetUrl, { provider: "firecrawl", apiKey: "fc-key" });
      expect(result).toEqual({ content: "# Firecrawl body", title: "FC Title" });

      expect(fetchMock).toHaveBeenCalledTimes(1);
      const [calledUrl, init] = fetchMock.mock.calls[0];
      expect(calledUrl).toBe("https://api.firecrawl.dev/v1/scrape");
      expect(init.method).toBe("POST");
      expect(JSON.parse(init.body)).toEqual({ url: targetUrl, formats: ["markdown"] });
      expect(init.headers.authorization).toBe("Bearer fc-key");
    });

    it("returns null when success:false", async () => {
      fetchMock.mockResolvedValue(jsonResponse({ success: false }));
      const result = await fetchViaHostedApi(targetUrl, { provider: "firecrawl", apiKey: "k" });
      expect(result).toBeNull();
    });

    it("returns null when markdown is missing", async () => {
      fetchMock.mockResolvedValue(jsonResponse({ success: true, data: {} }));
      const result = await fetchViaHostedApi(targetUrl, { provider: "firecrawl", apiKey: "k" });
      expect(result).toBeNull();
    });
  });

  it("returns null (never throws) when fetch rejects", async () => {
    fetchMock.mockRejectedValue(new Error("network down"));
    const result = await fetchViaHostedApi(targetUrl, { provider: "jina", apiKey: "k" });
    expect(result).toBeNull();
  });

  it("returns null on malformed JSON", async () => {
    fetchMock.mockResolvedValue({ ok: true, arrayBuffer: async () => new TextEncoder().encode("{not json").buffer });
    const result = await fetchViaHostedApi(targetUrl, { provider: "jina", apiKey: "k" });
    expect(result).toBeNull();
  });
});

// ── kill-switch (FEEDFERRET_DISABLE_HOSTED_FETCH) ────────────────────────────

describe("fetchViaHostedApi — kill-switch", () => {
  const original = process.env.FEEDFERRET_DISABLE_HOSTED_FETCH;
  afterEach(() => {
    if (original === undefined) delete process.env.FEEDFERRET_DISABLE_HOSTED_FETCH;
    else process.env.FEEDFERRET_DISABLE_HOSTED_FETCH = original;
    vi.resetModules();
  });

  it("returns null without ever calling fetch when disabled via env", async () => {
    process.env.FEEDFERRET_DISABLE_HOSTED_FETCH = "1";
    vi.resetModules();
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);
    const { fetchViaHostedApi: freshFetch } = await import("../../lib/hosted-fetch");
    const result = await freshFetch("https://example.com/", { provider: "jina", apiKey: "k" });
    expect(result).toBeNull();
    expect(fetchSpy).not.toHaveBeenCalled();
    vi.unstubAllGlobals();
  });
});
