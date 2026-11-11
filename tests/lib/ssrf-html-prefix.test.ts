// fetchWithSsrfProtection `untilHead` through the REAL transport + redirect
// loop against a local HTTP server (allowInternal: the server is loopback).
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import http from "node:http";
import type { AddressInfo } from "node:net";

vi.mock("@/lib/db", () => ({ db: { globalSettings: { findUnique: async () => null } } }));

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
      res.on("close", () => undefined);
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

  it("still enforces the SSRF guard (internal target refused without allowInternal)", async () => {
    await expect(fetchWithSsrfProtection(`${origin}/start`, {}, { untilHead: true })).rejects.toThrow();
  });
});
