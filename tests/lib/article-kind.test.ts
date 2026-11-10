import { describe, expect, it } from "vitest";
import {
  computeArticleMeta,
  deriveKind,
  estimateReadMinutes,
  htmlToPlainText,
  parseDurationSecs,
  pickMedia,
  type DeriveKindInput,
} from "../../lib/article-kind";
import { mediaFromItem } from "../../lib/feed-fetcher";

const base: DeriveKindInput = {
  link: "https://blog.example.com/posts/hello",
  feedUrl: "https://blog.example.com/feed.xml",
  title: "A proper headline",
  textLength: 4000,
  text: "Lorem ipsum dolor sit amet, a long article body follows here.",
  imageUrl: null,
};

describe("deriveKind (first match wins)", () => {
  const table: Array<[string, Partial<DeriveKindInput>, ReturnType<typeof deriveKind>]> = [
    ["plain article", {}, "article"],
    ["audio enclosure", { enclosureType: "audio/mpeg" }, "audio"],
    ["iTunes duration without enclosure type", { durationSecs: 1800 }, "audio"],
    ["audio beats a video host link", { enclosureType: "audio/mp4", link: "https://www.youtube.com/watch?v=1" }, "audio"],
    ["video enclosure with duration stays video", { enclosureType: "video/mp4", durationSecs: 600 }, "video"],
    ["video enclosure", { enclosureType: "video/mp4" }, "video"],
    ["youtube.com link", { link: "https://www.youtube.com/watch?v=abc" }, "video"],
    ["m.youtube.com link", { link: "https://m.youtube.com/watch?v=abc" }, "video"],
    ["youtu.be link", { link: "https://youtu.be/abc" }, "video"],
    ["vimeo link", { link: "https://vimeo.com/123" }, "video"],
    ["twitch link", { link: "https://www.twitch.tv/somebody" }, "video"],
    ["PeerTube watch path", { link: "https://tube.example.org/videos/watch/9c9de5e8" }, "video"],
    ["YouTube channel feed", { link: "https://example.com/x", feedUrl: "https://www.youtube.com/feeds/videos.xml?channel_id=UC1" }, "video"],
    ["video beats social", { link: "https://youtu.be/abc", title: "" , textLength: 10 }, "video"],
    ["empty title + short body", { title: "", textLength: 120 }, "social"],
    ["'Untitled' + short body", { title: "Untitled", textLength: 120 }, "social"],
    [
      "title = first 60 chars of a short body",
      { title: "Just shipped the new release of our tiny CLI tool, check it", text: "Just shipped the new release of our tiny CLI tool, check it out at https://example.com", textLength: 90 },
      "social",
    ],
    [
      "ellipsis-truncated title of a short body",
      { title: "Just shipped the new release…", text: "Just shipped the new release of our tool today", textLength: 46 },
      "social",
    ],
    ["empty title but long body is not social", { title: "", textLength: 2000 }, "article"],
    ["bsky.app link", { link: "https://bsky.app/profile/a.bsky.social/post/3k" }, "social"],
    ["t.me link", { link: "https://t.me/channel/42" }, "social"],
    ["threads.net link", { link: "https://www.threads.net/@someone/post/1" }, "social"],
    ["x.com link", { link: "https://x.com/someone/status/1" }, "social"],
    ["Mastodon status path", { link: "https://mastodon.social/@alice/112233445566" }, "social"],
    ["image with tiny body", { imageUrl: "https://cdn.example.com/a.jpg", textLength: 20 }, "image"],
    ["image with real body is an article", { imageUrl: "https://cdn.example.com/a.jpg", textLength: 400 }, "article"],
    ["unknown text length is never social/image by length", { title: "", textLength: null, imageUrl: "https://x/y.jpg" }, "article"],
    ["broken link", { link: "not a url" }, "article"],
  ];
  it.each(table)("%s", (_name, patch, expected) => {
    expect(deriveKind({ ...base, ...patch })).toBe(expected);
  });
});

describe("helpers", () => {
  it("parses iTunes durations", () => {
    expect(parseDurationSecs("3723")).toBe(3723);
    expect(parseDurationSecs("62:03")).toBe(3723);
    expect(parseDurationSecs("1:02:03")).toBe(3723);
    expect(parseDurationSecs(90)).toBe(90);
    expect(parseDurationSecs("")).toBeNull();
    expect(parseDurationSecs("soon")).toBeNull();
    expect(parseDurationSecs("0")).toBeNull();
  });

  it("estimates reading time at 200 wpm, null for empty text", () => {
    expect(estimateReadMinutes("")).toBeNull();
    expect(estimateReadMinutes("one two three")).toBe(1);
    expect(estimateReadMinutes(Array(401).fill("w").join(" "))).toBe(3);
    // CJK characters count as words.
    expect(estimateReadMinutes("漢".repeat(450))).toBe(3);
  });

  it("strips tags/scripts and decodes entities", () => {
    expect(htmlToPlainText("<p>Hi&nbsp;<b>there</b> &amp; &#x263A;</p><script>alert(1)</script>")).toBe("Hi there & ☺");
  });

  it("picks the first audio/video enclosure, else media:content", () => {
    expect(pickMedia({ enclosures: JSON.stringify([{ href: "https://x/a.jpg", type: "image/jpeg" }, { href: "https://x/a.mp3", type: "audio/mpeg" }]) }))
      .toEqual({ url: "https://x/a.mp3", type: "audio/mpeg", durationSecs: null });
    expect(pickMedia({ enclosures: "[]", mediaUrl: "https://x/v.mp4", mediaType: "video/mp4", durationSecs: 60 }))
      .toEqual({ url: "https://x/v.mp4", type: "video/mp4", durationSecs: 60 });
    expect(pickMedia({ enclosures: "not json" })).toBeNull();
  });

  it("reads media:content and itunes:duration from parsed feed items", () => {
    expect(mediaFromItem({ ffMediaContent: [{ $: { url: "https://x/i.jpg", medium: "image" } }, { $: { url: "https://x/v.mp4", type: "video/mp4", duration: "75" } }] }))
      .toEqual({ media: { url: "https://x/v.mp4", type: "video/mp4" }, durationSecs: 75 });
    expect(mediaFromItem({ itunes: { duration: "10:00" } })).toEqual({ media: null, durationSecs: 600 });
  });

  it("computes the full column set from stored fields", () => {
    const meta = computeArticleMeta({
      content: "<p>" + Array(250).fill("word").join(" ") + "</p>",
      title: "Episode 12",
      link: "https://pod.example.com/12",
      enclosures: JSON.stringify([{ href: "https://pod.example.com/12.mp3", type: "audio/mpeg" }]),
      durationSecs: 1200,
    });
    expect(meta).toEqual({ kind: "audio", readMinutes: 2, mediaUrl: "https://pod.example.com/12.mp3", mediaType: "audio/mpeg", mediaDurationSecs: 1200 });
    expect(computeArticleMeta({ content: "", title: "x", link: "https://e.com/" }).readMinutes).toBeNull();
  });
});

describe("parseDurationSecs bounds (Postgres Int)", () => {
  it("rejects durations beyond signed 32-bit", () => {
    expect(parseDurationSecs("2147483648")).toBeNull();
    expect(parseDurationSecs(2 ** 40)).toBeNull();
    expect(parseDurationSecs("99999999:00:00")).toBeNull();
    expect(parseDurationSecs("2147483647")).toBe(2147483647);
    expect(parseDurationSecs(Number.POSITIVE_INFINITY)).toBeNull();
  });
});
