import { describe, expect, it } from "vitest";
import { FEED_SNIFF_BYTES, sniffFeedPrefix } from "../../lib/feed-discovery";
import { parseYoutubePage } from "../../lib/smart-url-resolver";

/**
 * ReDoS guards for the raw-text scanners discovery runs on fetched,
 * attacker-controlled bytes: the feed prefix sniff (every candidate, 64 KiB)
 * and the YouTube page parser (up to 4 MiB). Each must stay linear.
 */

const timed = (fn: () => unknown) => {
  const t0 = performance.now();
  fn();
  return performance.now() - t0;
};
const prefix = (s: string) => s.slice(0, FEED_SNIFF_BYTES);

describe("sniffFeedPrefix on hostile prefixes", () => {
  it.each([
    ["unterminated <title", prefix(`<rss><channel>${"<title ".repeat(20_000)}`)],
    ["open <title> without close", prefix(`<rss><channel>${"<title>".repeat(20_000)}`)],
    ["unterminated <guid in an item", prefix(`<rss><channel><item>${"<guid ".repeat(20_000)}`)],
    ["atom entry with <link but no href", prefix(`<feed><entry>${"<link ".repeat(20_000)}`)],
    ["CDATA openers in a title", prefix(`<rss><channel><title>${"<![CDATA[".repeat(10_000)}</title>`)],
    ["doctype followed by whitespace only", prefix(`<!DOCTYPE rss${" ".repeat(65_000)}`)],
  ])("%s: < 200 ms", (_label, text) => {
    expect(timed(() => sniffFeedPrefix(text))).toBeLessThan(200);
  });

  it("still reads normal feeds", () => {
    expect(sniffFeedPrefix('<rss><channel><title>T &amp; U</title><item><guid isPermaLink="false">g1</guid></item></channel></rss>')).toEqual({
      type: "rss",
      title: "T & U",
      signature: "rss|T & U|g1",
    });
    expect(sniffFeedPrefix('<feed xmlns="http://www.w3.org/2005/Atom"><title>A</title><entry><link rel="alternate" href="https://a.example/1"/></entry></feed>'))
      .toEqual({ type: "atom", title: "A", signature: "atom|A|https://a.example/1" });
  });
});

describe("parseYoutubePage on hostile pages", () => {
  it.each([
    ["1 MB of unterminated <meta", "<meta ".repeat(170_000)],
    ["1 MB of unterminated canonical <link", '<link rel="canonical" '.repeat(50_000)],
    ["itemprop=name links without content", '<link itemprop="name" '.repeat(50_000)],
  ])("%s: < 200 ms", (_label, html) => {
    expect(timed(() => parseYoutubePage(html))).toBeLessThan(200);
  });
});
