import fs from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import Parser from "rss-parser";

// Recorded from the live service on 2026-11-10 (query "Elektroauto when:1d",
// de-DE). No test here touches the network.
const FIXTURES = path.resolve(__dirname, "../fixtures/google-news");
const RSS = fs.readFileSync(path.join(FIXTURES, "search-elektroauto.xml"), "utf8");
const SPLASH = fs.readFileSync(path.join(FIXTURES, "article-splash.html"), "utf8");
const BATCH = fs.readFileSync(path.join(FIXTURES, "batchexecute-response.txt"), "utf8");

const ID_WELT =
  "CBMi8wFBVV95cUxPNmdnOEdoRDFRUDNPcHg3bU85V2p2bVIwQlhfXzFham9YamxHT2ljdTZVTGtneVY2VGJRVjBQNFZSQWdUS0dNc2tFRUdIbXVya0E5VkVKbW1yVXp2RlJDLWQtVGpyLXVkc0dGcEVlWGMxZHFaRkgzZi1kOXZhS3lFQl9nekQ5dXJyTmJseFJERjg1Rm1hWFYzbmFzdWthelY5R1hvdzFlSDA3eHJvS0JHeDRHVjFwM3Axb3pYd0JNejg1dWVMT3NWUl9WZmt4SmtmemFpb3ZlcUsxQnNKektVekpCMkFqcnduaV93YXRwY1dSUDg";
const ID_MM =
  "CBMi7wFBVV95cUxPSkxubWxMTDZ6R0NDdkk5OEM1VE9rVmwxNDZLaWg2NEJOV0Z1YjhOQjZndGU0V0VNRHRCSGNjelVhRXFaVVgzckxlUU56RktiWFZ1MWNoUG5HbFhkODZCX0xfbzFRa0thVXdwajdjckpNNTFpYjJ5LVR6c3dUc01DVGtjbEYwUEgwVFhnSUZwaG55eWRGXzM4cUxuTXRBV3h3aWJ2akQ3QXpTbms3cDgtd3pFM0Y3blJmUnE3dDl4T2J4YVJpR2NDb2NBZV92NC1lUFpIYXVmM3EwbVhfZF9hR1VhV1JGUFQyam9lemxEOA";
const link = (id: string) => `https://news.google.com/rss/articles/${id}?oc=5`;

const dbState = vi.hoisted(() => ({ rows: [] as Array<Record<string, unknown>> }));
vi.mock("@/lib/db", () => ({
  getDatabaseProvider: () => "sqlite",
  db: {
    article: {
      findMany: vi.fn(async ({ where }: { where: { dedupeKey: { in: string[] } } }) =>
        dbState.rows.filter((r) => where.dedupeKey.in.includes(r.dedupeKey as string)),
      ),
    },
    globalSettings: { findUnique: vi.fn(async () => null) },
  },
}));

import {
  GOOGLE_NEWS_MAX_QUERY,
  buildGoogleNewsSearchUrl,
  googleNewsEdition,
  googleNewsFeedName,
  googleNewsLocaleParams,
  isGoogleNewsRssUrl,
  parseGoogleNewsSearchUrl,
} from "@/lib/google-news-url";
import {
  buildBatchExecuteBody,
  cleanGoogleNewsTitle,
  decodeGoogleNewsArticleIdOffline,
  extractGoogleNewsArticleId,
  isTrustedGoogleNewsOverrideUrl,
  parseBatchExecuteResponse,
  parseDecodingParams,
  resetGoogleNewsResolverState,
  resolveGoogleNewsLinks,
  safePublisherUrl,
} from "@/lib/google-news";
import { prepareGoogleNewsArticles } from "@/lib/google-news-ingest";
import { politeUpdateFrequency } from "@/lib/rss-sync";

describe("Google News search URLs", () => {
  it("builds the RSS search URL with encoded query and locale params", () => {
    expect(buildGoogleNewsSearchUrl({ query: "Elektroauto", edition: "de-DE" })).toBe(
      "https://news.google.com/rss/search?q=Elektroauto&hl=de&gl=DE&ceid=DE%3Ade",
    );
    expect(buildGoogleNewsSearchUrl({ query: "local first", edition: "en-GB" })).toBe(
      "https://news.google.com/rss/search?q=local%20first&hl=en-GB&gl=GB&ceid=GB%3Aen",
    );
    expect(buildGoogleNewsSearchUrl({ query: "Bahn", edition: "de-AT" })).toContain("&hl=de&gl=AT&ceid=AT%3Ade");
  });

  it("passes operators through and encodes umlauts, quotes, OR, -exclude, site:", () => {
    const url = buildGoogleNewsSearchUrl({ query: '"Wärmepumpe Förderung" OR Heizungsgesetz -Österreich site:tagesschau.de', edition: "de-DE" })!;
    const q = new URL(url).searchParams.get("q");
    expect(q).toBe('"Wärmepumpe Förderung" OR Heizungsgesetz -Österreich site:tagesschau.de');
    expect(url).toContain("q=%22W%C3%A4rmepumpe%20F%C3%B6rderung%22%20OR%20Heizungsgesetz%20-%C3%96sterreich%20site%3Atagesschau.de&");
    // & and # inside the query can never break out of the q parameter.
    const tricky = new URL(buildGoogleNewsSearchUrl({ query: "AT&T #5G", edition: "en-US" })!);
    expect(tricky.searchParams.get("q")).toBe("AT&T #5G");
    expect(tricky.searchParams.get("hl")).toBe("en-US");
    expect(tricky.hash).toBe("");
  });

  it("appends the time window as a trailing when: token and replaces an explicit one", () => {
    const url = buildGoogleNewsSearchUrl({ query: "KI", edition: "de-DE", when: "7d" })!;
    expect(new URL(url).searchParams.get("q")).toBe("KI when:7d");
    const replaced = buildGoogleNewsSearchUrl({ query: "KI when:1h", edition: "de-DE", when: "1d" })!;
    expect(new URL(replaced).searchParams.get("q")).toBe("KI when:1d");
    // Unknown windows are ignored.
    expect(new URL(buildGoogleNewsSearchUrl({ query: "KI", when: "99y" })!).searchParams.get("q")).toBe("KI");
  });

  it("normalizes whitespace/control chars, caps length, rejects empty queries", () => {
    expect(buildGoogleNewsSearchUrl({ query: "   " })).toBeNull();
    expect(new URL(buildGoogleNewsSearchUrl({ query: " a \n\t b " })!).searchParams.get("q")).toBe("a b");
    const long = new URL(buildGoogleNewsSearchUrl({ query: "x".repeat(500) })!).searchParams.get("q")!;
    expect(long.length).toBe(GOOGLE_NEWS_MAX_QUERY);
  });

  it("round-trips through parse, including the format the topic resolver produces", () => {
    const url = buildGoogleNewsSearchUrl({ query: '"Open Source" -crypto', edition: "en-GB", when: "1d" })!;
    expect(parseGoogleNewsSearchUrl(url)).toEqual({ query: '"Open Source" -crypto', edition: "en-GB", when: "1d" });
    expect(parseGoogleNewsSearchUrl("https://news.google.com/rss/search?q=local%20first%20software&hl=de&gl=DE&ceid=DE%3Ade")).toEqual({
      query: "local first software",
      edition: "de-DE",
      when: "",
    });
    expect(parseGoogleNewsSearchUrl("https://news.google.com/rss/search?q=x&hl=en-US&gl=US&ceid=US:en")?.edition).toBe("en-US");
    expect(parseGoogleNewsSearchUrl("https://example.com/rss/search?q=x")).toBeNull();
    expect(parseGoogleNewsSearchUrl("https://news.google.com/rss/topics/abc")).toBeNull();
    expect(parseGoogleNewsSearchUrl("not a url")).toBeNull();
    expect(isGoogleNewsRssUrl("https://news.google.com/rss/topics/abc")).toBe(true);
  });

  it("derives editions from UI locales (default de-DE) and the hl/gl/ceid triple", () => {
    expect(googleNewsEdition("de")).toBe("de-DE");
    expect(googleNewsEdition("en")).toBe("en-US");
    expect(googleNewsEdition("pt_BR")).toBe("pt-BR");
    expect(googleNewsEdition(null)).toBe("de-DE");
    expect(googleNewsLocaleParams("en-GB")).toEqual({ hl: "en-GB", gl: "GB", ceid: "GB:en" });
    expect(googleNewsLocaleParams("de-CH")).toEqual({ hl: "de", gl: "CH", ceid: "CH:de" });
  });

  it("names feeds after the query", () => {
    expect(googleNewsFeedName("  Elektroauto   -Tesla ")).toBe("Google News: Elektroauto -Tesla");
  });
});

describe("Google News article links", () => {
  it("extracts article ids only from Google News article paths", () => {
    expect(extractGoogleNewsArticleId(link(ID_WELT))).toBe(ID_WELT);
    expect(extractGoogleNewsArticleId(`https://news.google.com/articles/${ID_MM}`)).toBe(ID_MM);
    expect(extractGoogleNewsArticleId(`https://news.google.com/read/${ID_MM}?hl=de`)).toBe(ID_MM);
    expect(extractGoogleNewsArticleId(`https://evil.example/rss/articles/${ID_MM}`)).toBeNull();
    expect(extractGoogleNewsArticleId("https://news.google.com/rss/search?q=x")).toBeNull();
    expect(extractGoogleNewsArticleId(null)).toBeNull();
  });

  it("decodes old-format ids offline and leaves new-format (AU_yqL…) ids to batchexecute", () => {
    const url = "https://www.example.de/politik/artikel-123.html";
    const payload = Buffer.concat([Buffer.from([0x08, 0x13, 0x22, url.length]), Buffer.from(url), Buffer.from([0xd2, 0x01, 0x00])]);
    expect(decodeGoogleNewsArticleIdOffline(payload.toString("base64url"))).toBe(url);
    // Recorded live ids are all new-format.
    expect(decodeGoogleNewsArticleIdOffline(ID_WELT)).toBeNull();
    expect(decodeGoogleNewsArticleIdOffline("not-base64!!")).toBeNull();
    const js = Buffer.concat([Buffer.from([0x08, 0x13, 0x22, 17]), Buffer.from("javascript:alert1")]);
    expect(decodeGoogleNewsArticleIdOffline(js.toString("base64url"))).toBeNull();
  });

  it("reads signature and timestamp from the recorded splash page", () => {
    expect(parseDecodingParams(SPLASH, ID_MM)).toEqual({ id: ID_MM, signature: "AdwtSYOKJyLCcSFjHG9pysxvIK_m", timestamp: 1794350423 });
    expect(parseDecodingParams("<html>consent</html>", ID_MM)).toBeNull();
  });

  it("builds a batched f.req body with one garturlreq envelope per article", () => {
    const body = buildBatchExecuteBody([
      { id: "A1", signature: "S1", timestamp: 111 },
      { id: "B2", signature: "S2", timestamp: 222 },
    ]);
    expect(body.startsWith("f.req=")).toBe(true);
    const outer = JSON.parse(decodeURIComponent(body.slice("f.req=".length)));
    expect(outer[0]).toHaveLength(2);
    const [rpc, inner, nil, reqId] = outer[0][1];
    expect([rpc, nil, reqId]).toEqual(["Fbv4je", null, "1"]);
    const args = JSON.parse(inner);
    expect(args[0]).toBe("garturlreq");
    expect(args.slice(2)).toEqual(["B2", 222, "S2"]);
  });

  it("parses the recorded batchexecute response, matching rows by request id (rows arrive out of order)", () => {
    const params = Array.from({ length: 6 }, (_, i) => ({ id: `id${i}`, signature: "s", timestamp: 1 }));
    const urls = parseBatchExecuteResponse(BATCH, params);
    expect(urls.size).toBe(6);
    expect(urls.get("id0")).toMatch(/^https:\/\/www\.welt\.de\/iconist\//);
    expect(urls.get("id1")).toMatch(/^https:\/\/www\.manager-magazin\.de\//);
    expect(urls.get("id4")).toBe("https://www.mobiflip.de/bundesregierung-will-elektroauto-praemie-aufstocken/");
    expect(urls.get("id5")).toMatch(/^https:\/\/www\.wiwo\.de\//);
    expect(parseBatchExecuteResponse("<html>sorry</html>", params).size).toBe(0);
  });

  it("only accepts http(s) publisher URLs that do not point back at Google News", () => {
    expect(safePublisherUrl("https://www.tagesschau.de/a.html")).toBe("https://www.tagesschau.de/a.html");
    expect(safePublisherUrl("javascript:alert(1)")).toBeNull();
    expect(safePublisherUrl("https://news.google.com/rss/articles/x")).toBeNull();
    expect(safePublisherUrl("https://user:pw@example.com/")).toBeNull();
  });

  it("strips the ' - Publisher' title suffix when the source is known", () => {
    expect(cleanGoogleNewsTitle("Bund erhöht Prämie - manager magazin", "manager magazin")).toBe("Bund erhöht Prämie");
    expect(cleanGoogleNewsTitle("Bund erhöht Prämie - manager magazin", null)).toBe("Bund erhöht Prämie - manager magazin");
    expect(cleanGoogleNewsTitle(" - WELT", "WELT")).toBe(" - WELT");
  });
});

/** Fake Google: splash pages for known ids, the recorded batchexecute response. */
function fakeGoogle(opts: { status?: number; slowMs?: number } = {}) {
  const calls: string[] = [];
  const fetchImpl = vi.fn(async (url: string, init: RequestInit) => {
    calls.push(url);
    if (opts.slowMs) await new Promise((r) => setTimeout(r, opts.slowMs));
    if (opts.status) throw new Error(`Fetch failed: ${opts.status}`);
    if (url.includes("/batchexecute")) {
      const outer = JSON.parse(decodeURIComponent(String(init.body).slice("f.req=".length)));
      // Answer each requested article with the recorded row of the same index.
      const ids: string[] = outer[0].map((env: string[]) => JSON.parse(env[1])[2]);
      const recorded = JSON.parse(BATCH.replace(/^\)\]\}'\s*/, "")) as unknown[][];
      const byOrder = [ID_WELT, ID_MM];
      const rows = ids.map((id, i) => {
        const source = recorded.find((row) => row[6] === String(byOrder.indexOf(id)))!;
        return [...source.slice(0, 6), String(i)];
      });
      return { notModified: false as const, text: `)]}'\n\n${JSON.stringify(rows)}`, etag: null, lastModified: null };
    }
    const id = /\/rss\/articles\/([^?]+)/.exec(url)![1];
    return { notModified: false as const, text: SPLASH.replace(/data-n-a-id="[^"]+"/, `data-n-a-id="${id}"`), etag: null, lastModified: null };
  });
  return { fetchImpl, calls };
}

describe("resolveGoogleNewsLinks", () => {
  beforeEach(() => resetGoogleNewsResolverState());

  it("resolves via splash page + one batched RPC, then serves repeats from cache", async () => {
    const google = fakeGoogle();
    const first = await resolveGoogleNewsLinks([link(ID_WELT), link(ID_MM)], { fetchImpl: google.fetchImpl, edition: "de-DE" });
    expect(first.get(link(ID_WELT))).toMatch(/^https:\/\/www\.welt\.de\//);
    expect(first.get(link(ID_MM))).toMatch(/^https:\/\/www\.manager-magazin\.de\//);
    expect(google.calls.filter((u) => u.includes("batchexecute"))).toHaveLength(1);
    expect(google.calls[0]).toContain("hl=de&gl=DE&ceid=DE%3Ade");

    const again = await resolveGoogleNewsLinks([link(ID_WELT), `https://news.google.com/rss/articles/${ID_WELT}`], { fetchImpl: google.fetchImpl });
    expect(again.size).toBe(2);
    expect(google.calls).toHaveLength(3); // nothing new
  });

  it("backs off globally after 429 and does not retry until the pause ends", async () => {
    const throttled = fakeGoogle({ status: 429 });
    expect((await resolveGoogleNewsLinks([link(ID_WELT), link(ID_MM)], { fetchImpl: throttled.fetchImpl })).size).toBe(0);
    const callsAfter429 = throttled.calls.length;
    expect(callsAfter429).toBeGreaterThanOrEqual(1);
    const healthy = fakeGoogle();
    expect((await resolveGoogleNewsLinks([link(ID_WELT)], { fetchImpl: healthy.fetchImpl })).size).toBe(0);
    expect(healthy.calls).toHaveLength(0);
  });

  it("respects the time budget and the per-call network cap", async () => {
    const slow = fakeGoogle({ slowMs: 50 });
    const t0 = Date.now();
    const result = await resolveGoogleNewsLinks([link(ID_WELT), link(ID_MM)], { fetchImpl: slow.fetchImpl, budgetMs: 400 });
    expect(Date.now() - t0).toBeLessThan(1_000);
    expect(result.size).toBe(2);

    resetGoogleNewsResolverState();
    const capped = fakeGoogle();
    await resolveGoogleNewsLinks([link(ID_WELT), link(ID_MM)], { fetchImpl: capped.fetchImpl, maxNetwork: 1 });
    expect(capped.calls.filter((u) => u.includes("/rss/articles/"))).toHaveLength(1);

    resetGoogleNewsResolverState();
    const none = fakeGoogle();
    expect((await resolveGoogleNewsLinks([link(ID_WELT)], { fetchImpl: none.fetchImpl, budgetMs: 0 })).size).toBe(0);
    expect(none.calls).toHaveLength(0);
  });

  it("caches failures (consent/HTML pages) instead of hammering", async () => {
    const consent = vi.fn(async () => ({ notModified: false as const, text: "<html>Before you continue</html>", etag: null, lastModified: null }));
    expect((await resolveGoogleNewsLinks([link(ID_WELT)], { fetchImpl: consent })).size).toBe(0);
    expect((await resolveGoogleNewsLinks([link(ID_WELT)], { fetchImpl: consent })).size).toBe(0);
    expect(consent).toHaveBeenCalledTimes(1);
  });

  it("ignores non-Google links", async () => {
    const google = fakeGoogle();
    expect((await resolveGoogleNewsLinks(["https://example.com/a"], { fetchImpl: google.fetchImpl })).size).toBe(0);
    expect(google.calls).toHaveLength(0);
  });
});

describe("prepareGoogleNewsArticles (ingest pre-pass)", () => {
  const feed = { id: "feed-1", url: "https://news.google.com/rss/search?q=Elektroauto&hl=de&gl=DE&ceid=DE%3Ade", unicityCriteria: "id" };

  async function recordedItems() {
    const parser = new Parser({ customFields: { item: [["source", "ffSource"]] } });
    const parsed = await parser.parseString(RSS);
    return parsed.items.map((item: Record<string, any>) => ({
      title: item.title as string,
      link: item.link as string,
      content: "",
      externalId: item.guid as string,
      publishedAt: new Date(item.pubDate as string),
      sourceName: (typeof item.ffSource === "string" ? item.ffSource : item.ffSource?._) as string,
    }));
  }

  beforeEach(() => {
    resetGoogleNewsResolverState();
    dbState.rows = [];
  });
  afterEach(() => vi.useRealTimers());

  it("resolves new items to publisher URLs, keeps the guid as identity, cleans titles", async () => {
    const items = await recordedItems();
    expect(items[0].sourceName).toBe("WELT");
    const google = fakeGoogle();
    const out = await prepareGoogleNewsArticles(feed, "user-1", items.slice(0, 2), { fetchImpl: google.fetchImpl });
    const welt = out.find((a) => a.externalId === ID_WELT)!;
    expect(welt.link).toMatch(/^https:\/\/www\.welt\.de\//);
    expect(welt.title).toBe("„Es war nicht unser Ziel, das effizienteste Elektroauto der Welt zu bauen“, sagt Lynfel Owen");
    expect(welt.author).toBe("WELT");
    expect(welt.linkCosmetic).toBeUndefined();
  });

  it("keeps stored link/title of existing rows and only retries recent rows still on a Google link", async () => {
    const items = await recordedItems();
    dbState.rows = [
      // Resolved earlier: untouched, no network.
      { dedupeKey: ID_WELT, link: "https://www.welt.de/stored", title: "Stored title", author: "WELT", createdAt: new Date() },
      // Still on the Google link, created recently: retried, flagged cosmetic.
      { dedupeKey: ID_MM, link: link(ID_MM), title: items[1].title, author: null, createdAt: new Date() },
    ];
    const google = fakeGoogle();
    const out = await prepareGoogleNewsArticles(feed, "user-1", items.slice(0, 2), { fetchImpl: google.fetchImpl });
    const welt = out.find((a) => a.externalId === ID_WELT)!;
    expect(welt).toMatchObject({ link: "https://www.welt.de/stored", title: "Stored title", author: "WELT" });
    expect(welt.linkCosmetic).toBeUndefined();
    const mm = out.find((a) => a.externalId === ID_MM)!;
    expect(mm.link).toMatch(/^https:\/\/www\.manager-magazin\.de\//);
    expect(mm.title).toBe(items[1].title); // stored (raw) title kept: no content change
    expect(mm.linkCosmetic).toBe(true);
    expect(google.calls.filter((u) => u.includes("/rss/articles/"))).toEqual([expect.stringContaining(ID_MM)]);
  });

  it("does not retry old rows and falls back to Google links when resolution fails", async () => {
    const items = await recordedItems();
    dbState.rows = [{ dedupeKey: ID_MM, link: link(ID_MM), title: "t", author: null, createdAt: new Date(Date.now() - 3 * 24 * 3600_000) }];
    const failing = fakeGoogle({ status: 500 });
    const out = await prepareGoogleNewsArticles(feed, "user-1", items.slice(0, 2), { fetchImpl: failing.fetchImpl });
    expect(out.find((a) => a.externalId === ID_MM)!.link).toBe(link(ID_MM));
    expect(out.find((a) => a.externalId === ID_WELT)!.link).toBe(link(ID_WELT));
    expect(failing.calls.every((u) => !u.includes(ID_MM))).toBe(true);
  });
});

describe("politeUpdateFrequency", () => {
  const gn = "https://news.google.com/rss/search?q=x&hl=de&gl=DE&ceid=DE%3Ade";
  it("enforces a 30-minute floor and exponential backoff only for Google News feeds", () => {
    expect(politeUpdateFrequency({ url: gn }, 5)).toBe(30);
    expect(politeUpdateFrequency({ url: gn }, 60)).toBe(60);
    expect(politeUpdateFrequency({ url: gn, consecutiveFailureCount: 2 }, 30)).toBe(120);
    expect(politeUpdateFrequency({ url: gn, consecutiveFailureCount: 50 }, 120)).toBe(24 * 60);
    expect(politeUpdateFrequency({ url: "https://example.com/feed.xml", consecutiveFailureCount: 3 }, 5)).toBe(5);
  });
});

describe("admin origin override", () => {
  const prev = process.env.FEEDFERRET_GOOGLE_NEWS_BASE_URL;
  afterEach(() => {
    if (prev === undefined) delete process.env.FEEDFERRET_GOOGLE_NEWS_BASE_URL;
    else process.env.FEEDFERRET_GOOGLE_NEWS_BASE_URL = prev;
  });

  it("trusts only the configured origin, never the public one or other hosts", () => {
    delete process.env.FEEDFERRET_GOOGLE_NEWS_BASE_URL;
    expect(isTrustedGoogleNewsOverrideUrl("https://news.google.com/rss/search?q=x")).toBe(false);
    process.env.FEEDFERRET_GOOGLE_NEWS_BASE_URL = "http://127.0.0.1:4092/anything";
    expect(isTrustedGoogleNewsOverrideUrl("http://127.0.0.1:4092/rss/search?q=x")).toBe(true);
    expect(isTrustedGoogleNewsOverrideUrl("http://127.0.0.1:4093/rss/search?q=x")).toBe(false);
    expect(isTrustedGoogleNewsOverrideUrl("https://news.google.com/rss/search?q=x")).toBe(false);
    expect(extractGoogleNewsArticleId(`http://127.0.0.1:4092/rss/articles/${ID_MM}`)).toBe(ID_MM);
  });
});
