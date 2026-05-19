import { describe, it, expect } from "vitest";
import {
  validateFeedUrl,
  validateOpml,
  MAX_FEED_URL_LENGTH,
  MAX_OPML_BYTES,
  MAX_LABEL_NAME,
  MAX_SEARCH_QUERY,
} from "../../lib/validation";

describe("validateFeedUrl", () => {
  it("passes a valid https URL", () => {
    expect(validateFeedUrl("https://example.com/feed.xml")).toBeNull();
  });

  it("passes a valid http URL", () => {
    expect(validateFeedUrl("http://example.com/feed")).toBeNull();
  });

  it("rejects ftp:// scheme", () => {
    expect(validateFeedUrl("ftp://example.com/feed")).not.toBeNull();
  });

  it("rejects an invalid URL", () => {
    expect(validateFeedUrl("not-a-url")).not.toBeNull();
  });

  it("accepts URL at exactly 2 048 characters", () => {
    const base = "https://example.com/";
    const path = "a".repeat(MAX_FEED_URL_LENGTH - base.length);
    expect(validateFeedUrl(base + path)).toBeNull();
  });

  it("rejects URL at 2 049 characters", () => {
    const base = "https://example.com/";
    const path = "a".repeat(MAX_FEED_URL_LENGTH - base.length + 1);
    expect(validateFeedUrl(base + path)).not.toBeNull();
  });
});

describe("validateOpml", () => {
  it("passes content below the size limit", () => {
    expect(validateOpml("<opml/>")).toBeNull();
  });

  it("passes content at exactly 5 MB", () => {
    const xml = "x".repeat(MAX_OPML_BYTES);
    expect(validateOpml(xml)).toBeNull();
  });

  it("rejects content exceeding 5 MB", () => {
    const xml = "x".repeat(MAX_OPML_BYTES + 1);
    expect(validateOpml(xml)).not.toBeNull();
  });
});

describe("constants", () => {
  it("MAX_FEED_URL_LENGTH is 2048", () => expect(MAX_FEED_URL_LENGTH).toBe(2048));
  it("MAX_OPML_BYTES is 5 MB", () => expect(MAX_OPML_BYTES).toBe(5 * 1024 * 1024));
  it("MAX_LABEL_NAME is 100", () => expect(MAX_LABEL_NAME).toBe(100));
  it("MAX_SEARCH_QUERY is 1000", () => expect(MAX_SEARCH_QUERY).toBe(1000));
});
