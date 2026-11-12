import { describe, it, expect, vi, beforeEach } from "vitest";

const mockSafeFetch = vi.fn();
const mockAssertSafeFetchUrl = vi.fn();
const mockIsTrustedFeedFetchingAllowed = vi.fn();

vi.mock("@/lib/ssrf", () => ({
  safeFetch: (...args: any[]) => mockSafeFetch(...args),
  assertSafeFetchUrl: (...args: any[]) => mockAssertSafeFetchUrl(...args),
  isTrustedFeedFetchingAllowed: (...args: any[]) => mockIsTrustedFeedFetchingAllowed(...args),
}));

import {
  testReadeckConfig,
  sendToReadeck,
  testLinkwardenConfig,
  sendToLinkwarden,
} from "@/lib/export-destinations";

describe("export-destinations", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockIsTrustedFeedFetchingAllowed.mockResolvedValue(false);
    mockAssertSafeFetchUrl.mockResolvedValue(new URL("https://example.com"));
  });

  describe("Readeck", () => {
    const config = {
      baseUrl: "https://readeck.example.com/",
      apiKey: "secret-readeck-key",
    };

    it("testReadeckConfig succeeds with 200 OK", async () => {
      mockSafeFetch.mockResolvedValueOnce({
        ok: true,
        status: 200,
      });

      const res = await testReadeckConfig(config);
      expect(res).toEqual({ success: true });

      expect(mockAssertSafeFetchUrl).toHaveBeenCalledWith("https://readeck.example.com/", expect.any(Object));
      expect(mockSafeFetch).toHaveBeenCalledWith(
        "https://readeck.example.com/api/profile",
        expect.objectContaining({
          method: "GET",
          headers: {
            Authorization: "Bearer secret-readeck-key",
            Accept: "application/json",
          },
        }),
        expect.any(Object),
      );
    });

    it("testReadeckConfig handles non-ok response", async () => {
      mockSafeFetch.mockResolvedValueOnce({
        ok: false,
        status: 401,
        body: { cancel: vi.fn().mockResolvedValue(undefined) },
      });

      const res = await testReadeckConfig(config);
      expect(res.success).toBe(false);
      expect(res.error).toContain("401");
    });

    it("testReadeckConfig handles fetch errors", async () => {
      mockSafeFetch.mockRejectedValueOnce(new Error("Connection refused"));

      const res = await testReadeckConfig(config);
      expect(res.success).toBe(false);
      expect(res.error).toBe("Connection refused");
    });

    it("sendToReadeck posts bookmark with correct payload and headers", async () => {
      mockSafeFetch.mockResolvedValueOnce({
        ok: true,
        status: 201,
      });

      const res = await sendToReadeck(config, {
        url: "https://news.example.com/post-1",
        title: "News Headline",
        tags: ["tech", "ai"],
      });

      expect(res).toEqual({ success: true });
      expect(mockSafeFetch).toHaveBeenCalledWith(
        "https://readeck.example.com/api/bookmarks",
        expect.objectContaining({
          method: "POST",
          headers: expect.objectContaining({
            Authorization: "Bearer secret-readeck-key",
            "Content-Type": "application/json",
          }),
          body: JSON.stringify({
            url: "https://news.example.com/post-1",
            title: "News Headline",
            labels: ["tech", "ai"],
          }),
        }),
        expect.any(Object),
      );
    });

    it("sendToReadeck handles server rejection", async () => {
      mockSafeFetch.mockResolvedValueOnce({
        ok: false,
        status: 422,
        body: { cancel: vi.fn().mockResolvedValue(undefined) },
      });

      const res = await sendToReadeck(config, {
        url: "https://news.example.com/invalid",
      });

      expect(res.success).toBe(false);
      expect(res.error).toContain("422");
    });
  });

  describe("Linkwarden", () => {
    const config = {
      baseUrl: "https://linkwarden.example.com",
      apiKey: "secret-linkwarden-token",
    };

    it("testLinkwardenConfig succeeds with 200 OK", async () => {
      mockSafeFetch.mockResolvedValueOnce({
        ok: true,
        status: 200,
      });

      const res = await testLinkwardenConfig(config);
      expect(res).toEqual({ success: true });

      expect(mockAssertSafeFetchUrl).toHaveBeenCalledWith("https://linkwarden.example.com", expect.any(Object));
      expect(mockSafeFetch).toHaveBeenCalledWith(
        "https://linkwarden.example.com/api/v1/collections",
        expect.objectContaining({
          method: "GET",
          headers: {
            Authorization: "Bearer secret-linkwarden-token",
            Accept: "application/json",
          },
        }),
        expect.any(Object),
      );
    });

    it("testLinkwardenConfig handles non-ok response", async () => {
      mockSafeFetch.mockResolvedValueOnce({
        ok: false,
        status: 403,
        body: { cancel: vi.fn().mockResolvedValue(undefined) },
      });

      const res = await testLinkwardenConfig(config);
      expect(res.success).toBe(false);
      expect(res.error).toContain("403");
    });

    it("sendToLinkwarden posts link with mapped tags array", async () => {
      mockSafeFetch.mockResolvedValueOnce({
        ok: true,
        status: 200,
      });

      const res = await sendToLinkwarden(config, {
        url: "https://article.example.org/123",
        title: "Article Name",
        tags: ["open-source", "rss"],
      });

      expect(res).toEqual({ success: true });
      expect(mockSafeFetch).toHaveBeenCalledWith(
        "https://linkwarden.example.com/api/v1/links",
        expect.objectContaining({
          method: "POST",
          headers: expect.objectContaining({
            Authorization: "Bearer secret-linkwarden-token",
            "Content-Type": "application/json",
          }),
          body: JSON.stringify({
            url: "https://article.example.org/123",
            name: "Article Name",
            tags: [{ name: "open-source" }, { name: "rss" }],
          }),
        }),
        expect.any(Object),
      );
    });

    it("sendToLinkwarden handles error", async () => {
      mockSafeFetch.mockResolvedValueOnce({
        ok: false,
        status: 500,
        body: { cancel: vi.fn().mockResolvedValue(undefined) },
      });

      const res = await sendToLinkwarden(config, {
        url: "https://article.example.org/fail",
      });

      expect(res.success).toBe(false);
      expect(res.error).toContain("500");
    });
  });
});
