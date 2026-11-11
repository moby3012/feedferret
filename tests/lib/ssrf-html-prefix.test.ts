// fetchWithSsrfProtection `untilHead` through the REAL transport + redirect
// loop against a local HTTP server — both the internal (allowInternal) agent
// and the IP-pinned dispatcher (#252): for the pinned case, `pinned.test`
// resolves to the loopback server and loopback is treated as public, so the
// request really goes through safeLookup at socket-connect time.
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import http from "node:http";
import type { AddressInfo } from "node:net";

const net = vi.hoisted(() => ({ loopbackIsPublic: false, socketLookups: 0 }));
vi.mock("@/lib/db", () => ({ db: { globalSettings: { findUnique: async () => null } } }));
vi.mock("@/lib/private-ip", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../lib/private-ip")>();
  return { ...actual, isPrivateIp: (ip: string) => (net.loopbackIsPublic && ip === "127.0.0.1" ? false : actual.isPrivateIp(ip)) };
});
vi.mock("dns/promises", async (importOriginal) => {
  const actual = await importOriginal<{ default: typeof import("dns/promises") }>();
  return { default: { ...actual.default, lookup: async (host: string, opts: object) => (host === "pinned.test" ? [{ address: "127.0.0.1", family: 4 }] : actual.default.lookup(host, opts as never)) } };
});
vi.mock("node:dns", async (importOriginal) => {
  const actual = await importOriginal<{ default: typeof import("node:dns") }>();
  return {
    default: {
      ...actual.default,
      lookup: (host: string, opts: object, cb: (...args: unknown[]) => void) => {
        net.socketLookups++;
        if (host === "pinned.test") return cb(null, [{ address: "127.0.0.1", family: 4 }]);
        return (actual.default.lookup as Function)(host, opts, cb);
      },
    },
  };
});

import { fetchWithSsrfProtection } from "../../lib/ssrf";

let server: http.Server;
let origin = "";
let bodyBytesWritten = 0;

beforeAll(async () => {
  server = http.createServer((req, res) => {
    if (req.url === "/start") {
      res.writeHead(302, { location: "/final/page" }).end();
      return;
    }
    if (req.url === "/final/page") {
      res.writeHead(200, { "content-type": "text/html; charset=iso-8859-1", link: '<feed.xml>; rel="alternate"; type="application/rss+xml"' });
      res.write(Buffer.from('<html><head><script>x="</head>"</script><title>Grüße</title><link rel="alternate" type="application/rss+xml" href="rss.xml"></head>', "latin1"));
      // A huge body follows; the reader must stop long before it ends.
      const chunk = Buffer.alloc(64 * 1024, 0x41);
      let sent = 0;
      const pump = () => {
        while (sent < 200) {
          sent++;
          bodyBytesWritten += chunk.length;
          if (!res.write(chunk)) return void res.once("drain", pump);
        }
        res.end();
      };
      pump();
      return;
    }
    if (req.url === "/one-big-chunk") {
      res.writeHead(200, { "content-type": "text/html" });
      res.end(`<html><head><title>t</title>${"a".repeat(5000)}`);
      return;
    }
    res.writeHead(404).end();
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  server.closeAllConnections?.();
  await new Promise((resolve) => server.close(resolve));
});

describe("fetchWithSsrfProtection untilHead", () => {
  it("follows redirects, exposes the final URL, decodes the charset and stops at the real </head>", async () => {
    const result = await fetchWithSsrfProtection(`${origin}/start`, {}, { allowInternal: true, untilHead: true, maxBytes: 1024 * 1024 });
    if (result.notModified) throw new Error("unexpected 304");
    expect(result.url).toBe(`${origin}/final/page`);
    expect(result.headers?.get("link")).toContain("feed.xml");
    expect(result.text).toContain("<title>Grüße</title>");
    expect(result.text.endsWith('href="rss.xml"></head>')).toBe(true);
    expect(bodyBytesWritten).toBeLessThan(200 * 64 * 1024);
  });

  it("caps the prefix at maxBytes without failing", async () => {
    const result = await fetchWithSsrfProtection(`${origin}/one-big-chunk`, {}, { allowInternal: true, untilHead: true, maxBytes: 1000 });
    if (result.notModified) throw new Error("unexpected 304");
    expect(Buffer.byteLength(result.text)).toBeLessThanOrEqual(1000);
  });

  it("works through the IP-pinned dispatcher (redirect, final URL, head stop)", async () => {
    net.loopbackIsPublic = true;
    net.socketLookups = 0;
    try {
      const pinnedOrigin = origin.replace("127.0.0.1", "pinned.test");
      const result = await fetchWithSsrfProtection(`${pinnedOrigin}/start`, {}, { untilHead: true, maxBytes: 1024 * 1024 });
      if (result.notModified) throw new Error("unexpected 304");
      expect(result.url).toBe(`${pinnedOrigin}/final/page`);
      expect(result.text.endsWith('href="rss.xml"></head>')).toBe(true);
      expect(net.socketLookups).toBeGreaterThan(0); // connect went through safeLookup
    } finally {
      net.loopbackIsPublic = false;
    }
  });

  it("the pinned dispatcher still refuses a private socket address", async () => {
    await expect(fetchWithSsrfProtection(`${origin.replace("127.0.0.1", "pinned.test")}/start`, {}, { untilHead: true })).rejects.toThrow();
  });

  it("still enforces the SSRF guard (internal target refused without allowInternal)", async () => {
    await expect(fetchWithSsrfProtection(`${origin}/start`, {}, { untilHead: true })).rejects.toThrow();
  });
});
