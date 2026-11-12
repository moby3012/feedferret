import { afterEach, describe, expect, it, vi } from "vitest";
import { execFileSync } from "node:child_process";
import { join } from "node:path";
import { getClientIdentifier, getClientIp, resetProxyCountWarning } from "../../lib/rate-limit";
import { ipLimiterKey, isProxyCountExplicit, isTrustedProxyPeer, normalizeIp } from "../../lib/client-ip";

const TOKEN = "test-peer-token";
const req = (headers: Record<string, string>) => new Request("https://example.test", { headers });
const withPeer = (peer: string, headers: Record<string, string> = {}) => req({ ...headers, "x-feedferret-peer": `${TOKEN}|${peer}` });

afterEach(() => { vi.unstubAllEnvs(); vi.restoreAllMocks(); resetProxyCountWarning(); });

describe("address normalisation", () => {
  it("keys IPv6 by /64 and IPv4-mapped IPv6 as IPv4", () => {
    expect(ipLimiterKey("2001:db8:1:2:aaaa:bbbb:cccc:dddd")).toBe("2001:db8:1:2::/64");
    expect(ipLimiterKey("2001:DB8:1:2::1")).toBe("2001:db8:1:2::/64");
    expect(ipLimiterKey("2001:db8:1:2:ffff:ffff:ffff:ffff")).toBe(ipLimiterKey("2001:db8:1:2::"));
    expect(ipLimiterKey("2001:db8:1:3::1")).not.toBe(ipLimiterKey("2001:db8:1:2::1"));
    expect(ipLimiterKey("[2001:db8::1]")).toBe("2001:db8:0:0::/64");
    expect(ipLimiterKey("fe80::1%eth0")).toBe("fe80:0:0:0::/64");
    expect(normalizeIp("::ffff:203.0.113.7")).toBe("203.0.113.7");
    expect(ipLimiterKey("::ffff:cb00:7107")).toBe("203.0.113.7");
    expect(ipLimiterKey("203.0.113.7")).toBe("203.0.113.7");
  });
  it("passes unparsable values through (bounded) instead of throwing", () => {
    expect(ipLimiterKey("not-an-ip")).toBe("not-an-ip");
    expect(ipLimiterKey("x".repeat(200))).toHaveLength(64);
    expect(ipLimiterKey("1.2.3.4.5")).toBe("1.2.3.4.5");
    expect(ipLimiterKey("1:2:3")).toBe("1:2:3");
  });
  it("one /64 is ONE limiter key, however many addresses it uses", () => {
    vi.stubEnv("TRUSTED_PROXY_COUNT", "1");
    const keys = new Set(Array.from({ length: 1000 }, (_, i) =>
      getClientIdentifier(req({ "x-forwarded-for": `2001:db8:77:9:${i.toString(16)}::${(i * 7).toString(16)}` }))));
    expect(keys).toEqual(new Set(["ip:2001:db8:77:9::/64"]));
  });
  it("the audit log keeps the full address", () => {
    vi.stubEnv("TRUSTED_PROXY_COUNT", "1");
    expect(getClientIp(req({ "x-forwarded-for": "2001:db8::5" }))).toBe("2001:db8:0:0:0:0:0:5");
  });
});

describe("trusted peers", () => {
  it.each(["127.0.0.1", "::1", "10.1.2.3", "172.18.0.4", "192.168.1.1", "169.254.1.1", "fd12:3456::1", "fe80::2", "::ffff:172.17.0.2"])("%s is a proxy candidate", (ip) => {
    expect(isTrustedProxyPeer(ip)).toBe(true);
  });
  it.each(["8.8.8.8", "172.32.0.1", "2001:db8::1", "::ffff:8.8.8.8", "garbage", "100.64.0.9", "100.127.255.254"])("%s is not (CGNAT / Tailscale peers are clients unless listed)", (ip) => {
    expect(isTrustedProxyPeer(ip)).toBe(false);
  });
  it("TRUSTED_PROXIES, when set, is the whole list (addresses and CIDRs); private peers are no longer implied", () => {
    vi.stubEnv("TRUSTED_PROXIES", "203.0.113.10, 198.51.100.0/24, 2001:db8:aaaa::/48, 100.64.0.0/10, bogus, 1.2.3.4/99");
    expect(isTrustedProxyPeer("100.64.0.9")).toBe(true);
    expect(isTrustedProxyPeer("172.18.0.4")).toBe(false);
    expect(isTrustedProxyPeer("127.0.0.1")).toBe(false);
    expect(isTrustedProxyPeer("203.0.113.10")).toBe(true);
    expect(isTrustedProxyPeer("198.51.100.77")).toBe(true);
    expect(isTrustedProxyPeer("2001:db8:aaaa:5::1")).toBe(true);
    expect(isTrustedProxyPeer("203.0.113.11")).toBe(false);
    expect(isTrustedProxyPeer("1.2.3.4")).toBe(false);
  });
});

describe("with the TCP peer available (production server)", () => {
  it("ignores a spoofed X-Forwarded-For from a public peer and warns once", () => {
    vi.stubEnv("FEEDFERRET_PEER_TOKEN", TOKEN);
    vi.stubEnv("TRUSTED_PROXY_COUNT", "1");
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    expect(getClientIdentifier(withPeer("198.51.100.20", { "x-forwarded-for": "1.1.1.1" }))).toBe("ip:198.51.100.20");
    expect(getClientIdentifier(withPeer("198.51.100.20", { "x-forwarded-for": "2.2.2.2" }))).toBe("ip:198.51.100.20");
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0][0]).toContain("TRUSTED_PROXIES");
    expect(warn.mock.calls[0][0]).not.toContain("198.51.100.20"); // no client addresses in logs
  });
  it("believes X-Forwarded-For from a private peer (Traefik) and from a TRUSTED_PROXIES peer", () => {
    vi.stubEnv("FEEDFERRET_PEER_TOKEN", TOKEN);
    vi.stubEnv("TRUSTED_PROXY_COUNT", "1");
    expect(getClientIdentifier(withPeer("172.18.0.4", { "x-forwarded-for": "spoof, 203.0.113.9" }))).toBe("ip:203.0.113.9");
    vi.stubEnv("TRUSTED_PROXIES", "198.51.100.20");
    expect(getClientIdentifier(withPeer("198.51.100.20", { "x-forwarded-for": "203.0.113.9" }))).toBe("ip:203.0.113.9");
  });
  it("with TRUSTED_PROXIES set, a private peer that is not listed is a client", () => {
    vi.stubEnv("FEEDFERRET_PEER_TOKEN", TOKEN);
    vi.stubEnv("TRUSTED_PROXY_COUNT", "1");
    vi.stubEnv("TRUSTED_PROXIES", "198.51.100.20");
    vi.spyOn(console, "warn").mockImplementation(() => {});
    expect(getClientIdentifier(withPeer("172.18.0.4", { "x-forwarded-for": "1.1.1.1" }))).toBe("ip:172.18.0.4");
  });
  it("TRUSTED_PROXY_COUNT=0 means no proxy: the peer is the client, headers are ignored, no warning", () => {
    vi.stubEnv("FEEDFERRET_PEER_TOKEN", TOKEN);
    vi.stubEnv("TRUSTED_PROXY_COUNT", "0");
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    expect(getClientIdentifier(withPeer("172.18.0.4", { "x-forwarded-for": "9.9.9.9", "x-real-ip": "8.8.8.8" }))).toBe("ip:172.18.0.4");
    expect(getClientIdentifier(withPeer("2001:db8:5:6:7:8:9:a", { "x-forwarded-for": "9.9.9.9" }))).toBe("ip:2001:db8:5:6::/64");
    expect(warn).not.toHaveBeenCalled();
  });
  it("a forged peer header (wrong or missing token) is ignored", () => {
    vi.stubEnv("FEEDFERRET_PEER_TOKEN", TOKEN);
    vi.stubEnv("TRUSTED_PROXY_COUNT", "1");
    expect(getClientIdentifier(req({ "x-feedferret-peer": "guess|172.18.0.4", "x-forwarded-for": "7.7.7.7" }))).toBe("ip:7.7.7.7"); // explicit count, no valid peer: the operator's word
    vi.stubEnv("FEEDFERRET_PEER_TOKEN", "");
    expect(getClientIdentifier(req({ "x-feedferret-peer": `${TOKEN}|172.18.0.4`, "x-forwarded-for": "7.7.7.7" }))).toBe("ip:7.7.7.7");
  });
  it("count 0 without peer information falls back to one shared key and warns once", () => {
    vi.stubEnv("TRUSTED_PROXY_COUNT", "0");
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    expect(getClientIdentifier(req({ "x-forwarded-for": "7.7.7.7" }))).toBe("ip:unknown");
    getClientIdentifier(req({}));
    expect(warn).toHaveBeenCalledTimes(1);
  });
});

/**
 * Matrix: TRUSTED_PROXY_COUNT (unset | 0 | 1 | 2) × TRUSTED_PROXIES (unset | set) × peer (none | private |
 * public | listed) with a forged X-Forwarded-For. The key is what the limiter would use.
 */
describe("trust matrix", () => {
  const SPOOF = "9.9.9.9";
  const key = (peer: string | null, headers: Record<string, string> = { "x-forwarded-for": `${SPOOF}, 203.0.113.9` }) =>
    getClientIdentifier(peer === null ? req(headers) : withPeer(peer, headers));
  const setup = (count: string | undefined, proxies?: string) => {
    vi.stubEnv("FEEDFERRET_PEER_TOKEN", TOKEN);
    if (count !== undefined) vi.stubEnv("TRUSTED_PROXY_COUNT", count);
    else vi.stubEnv("TRUSTED_PROXY_COUNT", "");
    if (proxies !== undefined) vi.stubEnv("TRUSTED_PROXIES", proxies);
    return vi.spyOn(console, "warn").mockImplementation(() => {});
  };

  describe("TRUSTED_PROXY_COUNT explicit ≥ 1, TRUSTED_PROXIES unset", () => {
    it("private / loopback peer → the Nth-from-right forwarded entry", () => {
      setup("1");
      expect(key("172.18.0.4")).toBe("ip:203.0.113.9");
      expect(key("127.0.0.1")).toBe("ip:203.0.113.9");
      setup("2");
      expect(key("10.0.0.2", { "x-forwarded-for": "7.7.7.7, 203.0.113.9, 10.0.0.1" })).toBe("ip:203.0.113.9");
    });
    it("public peer → the peer, the forged header is ignored (and warned about once)", () => {
      const warn = setup("1");
      expect(key("198.51.100.20")).toBe("ip:198.51.100.20");
      expect(key("198.51.100.21")).toBe("ip:198.51.100.21");
      expect(warn).toHaveBeenCalledTimes(1);
    });
    it("CGNAT / Tailscale peer → a client, not a proxy", () => {
      setup("1");
      expect(key("100.101.102.103")).toBe("ip:100.101.102.103");
    });
    it("no peer information → the operator's explicit count is taken at its word", () => {
      setup("1");
      expect(key(null)).toBe("ip:203.0.113.9");
    });
  });

  describe("TRUSTED_PROXY_COUNT explicit ≥ 1, TRUSTED_PROXIES set", () => {
    it("only a listed peer is a proxy: listed → header, private-but-unlisted → peer, public-unlisted → peer", () => {
      setup("1", "203.0.113.200, 192.0.2.0/24");
      expect(key("203.0.113.200")).toBe("ip:203.0.113.9");
      expect(key("192.0.2.55")).toBe("ip:203.0.113.9");
      expect(key("172.18.0.4")).toBe("ip:172.18.0.4");
      expect(key("198.51.100.20")).toBe("ip:198.51.100.20");
    });
    it("an unparsable list is the same as an unset one", () => {
      setup("1", "bogus, 1.2.3.4/99");
      expect(key("172.18.0.4")).toBe("ip:203.0.113.9");
    });
  });

  describe("TRUSTED_PROXY_COUNT=0", () => {
    it("the peer is the client whatever it is, with or without TRUSTED_PROXIES; no peer → shared key", () => {
      const warn = setup("0", "172.18.0.4");
      expect(key("172.18.0.4")).toBe("ip:172.18.0.4");
      expect(key("100.101.102.103")).toBe("ip:100.101.102.103");
      expect(key("198.51.100.20")).toBe("ip:198.51.100.20");
      expect(warn).not.toHaveBeenCalled();
      expect(key(null)).toBe("ip:unknown");
    });
  });

  describe("TRUSTED_PROXY_COUNT unset / invalid (legacy compatibility mode)", () => {
    it.each([undefined, "abc", "-1", "1.5"])("count %j: a private peer is still believed, with a loud warning", (count) => {
      const warn = setup(count);
      expect(key("172.18.0.4")).toBe("ip:203.0.113.9");
      expect(warn).toHaveBeenCalledTimes(1);
      const text = String(warn.mock.calls[0][0]);
      expect(text).toContain("TRUSTED_PROXY_COUNT");
      expect(text).toContain("clients can choose their own rate-limit key");
      expect(text).toContain("TRUSTED_PROXY_COUNT=0");
    });
    it("a public or CGNAT peer is a client; TRUSTED_PROXIES narrows the trust here too", () => {
      setup(undefined);
      expect(key("198.51.100.20")).toBe("ip:198.51.100.20");
      expect(key("100.101.102.103")).toBe("ip:100.101.102.103");
      setup(undefined, "203.0.113.200");
      expect(key("172.18.0.4")).toBe("ip:172.18.0.4");
      expect(key("203.0.113.200")).toBe("ip:203.0.113.9");
    });
    it("no peer information fails CLOSED: forwarded headers are not believed, one shared key, warned once", () => {
      const warn = setup(undefined);
      expect(key(null)).toBe("ip:unknown");
      expect(key(null, { "x-forwarded-for": "5.5.5.5", "x-real-ip": "6.6.6.6" })).toBe("ip:unknown");
      expect(warn.mock.calls.filter(([m]) => String(m).includes("No TCP peer information"))).toHaveLength(1);
    });
    it("a forged peer header does not make a client a proxy", () => {
      setup(undefined);
      expect(getClientIdentifier(req({ "x-feedferret-peer": "guess|172.18.0.4", "x-forwarded-for": "7.7.7.7" }))).toBe("ip:unknown");
    });
  });

  it("an explicit 0 never triggers the unset-count warning", () => {
    const warn = setup("0");
    key("172.18.0.4");
    expect(warn).not.toHaveBeenCalled();
    expect(isProxyCountExplicit()).toBe(true);
    vi.stubEnv("TRUSTED_PROXY_COUNT", "");
    expect(isProxyCountExplicit()).toBe(false);
  });
});

describe("scripts/peer-address-preload.cjs", () => {
  it("stamps the real socket peer and overwrites a client-supplied header", async () => {
    const script = `
      const http = require("node:http");
      const s = http.createServer((req, res) => res.end(req.headers["x-feedferret-peer"] || ""));
      s.listen(0, "127.0.0.1", () => {
        const sent = [];
        http.get({ port: s.address().port, host: "127.0.0.1", headers: { "x-feedferret-peer": "forged|1.2.3.4" } }, (res) => {
          let body = ""; res.on("data", (c) => body += c); res.on("end", () => { console.log(JSON.stringify({ body, token: process.env.FEEDFERRET_PEER_TOKEN })); s.close(); });
        });
      });`;
    const out = execFileSync(process.execPath, ["--require", join(process.cwd(), "scripts/peer-address-preload.cjs"), "-e", script], { encoding: "utf8" });
    const { body, token } = JSON.parse(out);
    expect(token).toMatch(/^[0-9a-f]{48}$/);
    expect(body).toBe(`${token}|127.0.0.1`);
  });
});
