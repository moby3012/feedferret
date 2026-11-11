import { readdir } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { SEED_FEEDS } from "@/lib/discovery-catalog-seeds";
import { DEFAULT_STARTER_PACKS } from "@/lib/starter-packs";
import { hydrateStarterPackFiles } from "@/lib/starter-packs.server";

// Offline guard for the feed lists we ship (starter OPML packs + discovery
// catalog seeds). Liveness is checked out-of-band with the opt-in bench
// (scripts/bench-opml.mjs --bundled); CI never touches the network.

// Hosts verified dead/blocked in the 2026-11-11 bundled bench.
const KNOWN_DEAD_HOSTS = ["feeds.reuters.com"];

function expectValidHttpsUrl(value: string, label: string) {
  let url: URL | null = null;
  try {
    url = new URL(value);
  } catch {
    // reported below
  }
  expect(url, `${label}: not a valid URL: ${value}`).not.toBeNull();
  expect(url!.protocol, `${label}: must be https: ${value}`).toBe("https:");
  expect(url!.hostname, `${label}: needs a hostname with a dot: ${value}`).toContain(".");
  expect(KNOWN_DEAD_HOSTS, `${label}: known-dead host: ${value}`).not.toContain(url!.hostname);
}

describe("shipped starter packs (public/starter-opml)", async () => {
  const packs = await hydrateStarterPackFiles(DEFAULT_STARTER_PACKS);

  it("every OPML file in public/starter-opml is registered as a default pack and vice versa", async () => {
    const files = (await readdir(path.join(process.cwd(), "public", "starter-opml")))
      .filter((f) => f.endsWith(".opml"))
      .sort();
    const registered = DEFAULT_STARTER_PACKS.map((p) => p.path).sort();
    expect(registered).toEqual(files);
  });

  it("every default pack hydrates with feeds from its OPML file", () => {
    for (const pack of packs) {
      expect(pack.feeds.length, `${pack.id} has no feeds`).toBeGreaterThan(0);
    }
  });

  it("all feed and site URLs are valid https", () => {
    for (const pack of packs) {
      for (const feed of pack.feeds) {
        expectValidHttpsUrl(feed.xmlUrl, `${pack.id} xmlUrl "${feed.title}"`);
        if (feed.htmlUrl) expectValidHttpsUrl(feed.htmlUrl, `${pack.id} htmlUrl "${feed.title}"`);
      }
    }
  });

  it("has no duplicate feeds within or across packs", () => {
    const seen = new Map<string, string>();
    for (const pack of packs) {
      for (const feed of pack.feeds) {
        const key = feed.xmlUrl.replace(/\/+$/, "").toLowerCase();
        expect(seen.get(key), `${feed.xmlUrl} in ${pack.id} duplicates ${seen.get(key)}`).toBeUndefined();
        seen.set(key, pack.id);
      }
    }
  });

  it("keeps packs balanced (feed counts differ by at most 1)", () => {
    const counts = packs.map((p) => p.feeds.length);
    expect(Math.max(...counts) - Math.min(...counts), `counts: ${counts.join(",")}`).toBeLessThanOrEqual(1);
  });
});

describe("discovery catalog seeds", () => {
  it("all URLs are valid https and unique", () => {
    const seen = new Set<string>();
    for (const feed of SEED_FEEDS) {
      expectValidHttpsUrl(feed.url, `seed "${feed.title}"`);
      const key = feed.url.toLowerCase();
      expect(seen.has(key), `duplicate seed: ${feed.url}`).toBe(false);
      seen.add(key);
    }
  });

  it("every seed has title, category and language", () => {
    for (const feed of SEED_FEEDS) {
      expect(feed.title, feed.url).toBeTruthy();
      expect(feed.category, feed.url).toBeTruthy();
      expect(feed.language, feed.url).toMatch(/^[a-z]{2}$/);
    }
  });
});
