// discoverFeeds through the REAL SSRF transport (fetchWithSsrfProtection →
// fetchOneHop → IP-pinned undici dispatcher) against a local HTTP server:
// redirect hops count against the run's request budget, a real 429 with
// Retry-After lands in the shared host backoff at the host that actually
// answered (after a cross-host redirect), and the run's deadline aborts an
// in-flight request. `pinned.test` / `other.test` resolve to the loopback
// server and loopback is treated as public (same harness as
// tests/lib/ssrf-html-prefix.test.ts), so requests really go through safeLookup.
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import http from "node:http";
import type { AddressInfo } from "node:net";

const net = vi.hoisted(() => ({ hits: [] as string[], aborted: 0 }));
vi.mock("@/lib/db", () => ({ db: { globalSettings: { findUnique: async () => null } } }));
vi.mock("@/lib/private-ip", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../lib/private-ip")>();
  return { ...actual, isPrivateIp: (ip: string) => (ip === "127.0.0.1" ? false : actual.isPrivateIp(ip)) };
});
vi.mock("dns/promises", async (importOriginal) => {
  const actual = await importOriginal<{ default: typeof import("dns/promises") }>();
  return {
    default: {
      ...actual.default,
      lookup: async (host: string, opts: object) =>
        ["pinned.test", "other.test"].includes(host) ? [{ address: "127.0.0.1", family: 4 }] : actual.default.lookup(host, opts as never),
    },
  };
});
vi.mock("node:dns", async (importOriginal) => {
  const actual = await importOriginal<{ default: typeof import("node:dns") }>();
  return {
    default: {
      ...actual.default,
      lookup: (host: string, opts: object, cb: (...args: unknown[]) => void) => {
        if (["pinned.test", "other.test"].includes(host)) return cb(null, [{ address: "127.0.0.1", family: 4 }]);
        return (actual.default.lookup as (...a: unknown[]) => void)(host, opts, cb);
      },
    },
  };
});
vi.mock("../../lib/rsshub", () => ({
  radarRoutesFor: () => [],
  getRsshubConfig: vi.fn(async () => null),
  validateRsshubRoute: vi.fn(),
  buildRsshubPublicRouteUrl: vi.fn(),
}));

import { discoverFeeds } from "../../lib/feed-discovery";
import { hostBackoffRemainingMs, resetHostBackoff } from "../../lib/host-backoff";

let server: http.Server;
let port = 0;
const at = (host: string, path: string) => `http://${host}:${port}${path}`;

beforeAll(async () => {
  server = http.createServer((req, res) => {
    const host = (req.headers.host ?? "").split(":")[0];
    net.hits.push(`${host}${req.url}`);
    switch (req.url) {
      case "/hop1":
        res.writeHead(302, { location: "/hop2" }).end();
        return;
      case "/hop2":
        res.writeHead(302, { location: "/page" }).end();
        return;
      case "/page":
        res.writeHead(200, { "content-type": "text/html" }).end(
          '<html><head><title>P</title><link rel="alternate" type="application/rss+xml" title="Real" href="/feed.xml"></head></html>',
        );
        return;
      case "/feed.xml":
        res.writeHead(200, { "content-type": "application/rss+xml" }).end(
          '<?xml version="1.0"?><rss version="2.0"><channel><title>Real feed</title><item><guid>r1</guid></item></channel></rss>',
        );
        return;
      case "/limited":
        res.writeHead(429, { "retry-after": "120" }).end("slow down");
        return;
      case "/to-other":
        res.writeHead(302, { location: at("other.test", "/limited") }).end();
        return;
      case "/hang":
        req.on("close", () => net.aborted++);
        res.writeHead(200, { "content-type": "text/html" });
        res.write("<html><head>"); // never finishes
        return;
      default:
        res.writeHead(404).end();
    }
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  port = (server.address() as AddressInfo).port;
});

afterAll(async () => {
  server.closeAllConnections?.();
  await new Promise((resolve) => server.close(resolve));
});

beforeEach(() => {
  net.hits.length = 0;
  net.aborted = 0;
  resetHostBackoff();
});
afterEach(() => resetHostBackoff());

describe("discovery over the real SSRF transport", () => {
  it("follows redirects and finds the advertised feed", async () => {
    const result = await discoverFeeds(at("pinned.test", "/hop1"));
    expect(result.feeds.map((f) => [f.url, f.title])).toEqual([[at("pinned.test", "/feed.xml"), "Real"]]);
    expect(result.partial).toBeUndefined();
  });

  it("every redirect hop counts against the request budget (2 requests cannot reach a page 2 hops away)", async () => {
    const result = await discoverFeeds(at("pinned.test", "/hop1"), { limits: { deadlineMs: 5_000, maxRequests: 2 } });
    expect(result.feeds).toEqual([]);
    expect(result.partial).toBe("request-budget");
    // hop1 + hop2 were sent; the hop to /page was refused before it went out.
    expect(net.hits).toEqual(["pinned.test/hop1", "pinned.test/hop2"]);
  });

  it("a real 429 with Retry-After blocks the host in the shared backoff for the server's window", async () => {
    const result = await discoverFeeds(at("pinned.test", "/limited"));
    expect(result.hint).toBe("rate-limited");
    const remaining = hostBackoffRemainingMs("http://pinned.test/");
    expect(remaining).toBeGreaterThan(110_000);
    expect(remaining).toBeLessThanOrEqual(5 * 60 * 1000);
    // Nothing else was asked of the host after the 429 (no retry, no common paths).
    expect(net.hits).toEqual(["pinned.test/limited"]);
  });

  it("the 429 is recorded for the host that answered it (final hop), not the one the user typed", async () => {
    await discoverFeeds(at("pinned.test", "/to-other"));
    expect(hostBackoffRemainingMs("http://other.test/")).toBeGreaterThan(110_000);
    expect(hostBackoffRemainingMs("http://pinned.test/")).toBe(0);
  });

  it("the run's deadline aborts the in-flight request and returns a partial result", async () => {
    const started = Date.now();
    const result = await discoverFeeds(at("pinned.test", "/hang"), { limits: { deadlineMs: 400, maxRequests: 30 } });
    expect(Date.now() - started).toBeLessThan(3_000);
    expect(result.feeds).toEqual([]);
    expect(result.partial).toBe("deadline");
    await vi.waitFor(() => expect(net.aborted).toBe(1));
  });
});
