import { describe, it, expect } from "vitest";
import { isPrivateIp } from "../../lib/ssrf";

// ── isPrivateIp — IPv4 ────────────────────────────────────────────────────────

describe("isPrivateIp — IPv4 private ranges", () => {
  it("blocks localhost 127.0.0.1", () => expect(isPrivateIp("127.0.0.1")).toBe(true));
  it("blocks loopback 127.0.0.2", () => expect(isPrivateIp("127.0.0.2")).toBe(true));
  it("blocks 10.x.x.x (RFC 1918)", () => expect(isPrivateIp("10.0.0.1")).toBe(true));
  it("blocks 10.255.255.255", () => expect(isPrivateIp("10.255.255.255")).toBe(true));
  it("blocks 192.168.x.x (RFC 1918)", () => expect(isPrivateIp("192.168.1.1")).toBe(true));
  it("blocks 192.168.255.255", () => expect(isPrivateIp("192.168.255.255")).toBe(true));
  it("blocks 172.16.0.0 (RFC 1918)", () => expect(isPrivateIp("172.16.0.0")).toBe(true));
  it("blocks 172.31.255.255", () => expect(isPrivateIp("172.31.255.255")).toBe(true));
  it("blocks 169.254.x.x (link-local)", () => expect(isPrivateIp("169.254.1.1")).toBe(true));
  it("blocks 0.0.0.0", () => expect(isPrivateIp("0.0.0.0")).toBe(true));
  it("blocks multicast 224.0.0.1", () => expect(isPrivateIp("224.0.0.1")).toBe(true));
  it("blocks CGNAT 100.64.0.1", () => expect(isPrivateIp("100.64.0.1")).toBe(true));
  it("blocks TEST-NET-1 192.0.2.1 (RFC 5737)", () => expect(isPrivateIp("192.0.2.1")).toBe(true));
  it("blocks TEST-NET-1 192.0.2.255", () => expect(isPrivateIp("192.0.2.255")).toBe(true));
});

describe("isPrivateIp — IPv4 public ranges", () => {
  it("allows 1.1.1.1 (Cloudflare DNS)", () => expect(isPrivateIp("1.1.1.1")).toBe(false));
  it("allows 8.8.8.8 (Google DNS)", () => expect(isPrivateIp("8.8.8.8")).toBe(false));
  it("allows 93.184.216.34 (example.com)", () => expect(isPrivateIp("93.184.216.34")).toBe(false));
  it("allows 172.15.0.1 (just below RFC 1918 range)", () => expect(isPrivateIp("172.15.255.255")).toBe(false));
  it("allows 172.32.0.1 (just above RFC 1918 range)", () => expect(isPrivateIp("172.32.0.0")).toBe(false));
  // Regression: a prior bug blocked all of 192.0.0.0/16 (matching on the
  // second octet only) instead of just 192.0.2.0/24 (TEST-NET-1), which
  // wrongly rejected real public feeds — e.g. a WordPress.com-hosted blog
  // resolving into Automattic's 192.0.78.0/23 allocation.
  it("allows 192.0.78.25 (WordPress.com/Automattic, not TEST-NET-1)", () =>
    expect(isPrivateIp("192.0.78.25")).toBe(false));
  it("allows 192.0.1.1 (just below TEST-NET-1)", () => expect(isPrivateIp("192.0.1.1")).toBe(false));
  it("allows 192.0.3.1 (just above TEST-NET-1)", () => expect(isPrivateIp("192.0.3.1")).toBe(false));
});

// ── isPrivateIp — IPv6 ────────────────────────────────────────────────────────

describe("isPrivateIp — IPv6 private ranges", () => {
  it("blocks ::1 (loopback)", () => expect(isPrivateIp("::1")).toBe(true));
  it("blocks :: (unspecified)", () => expect(isPrivateIp("::")).toBe(true));
  it("blocks fc00::/7 (ULA)", () => expect(isPrivateIp("fc00::1")).toBe(true));
  it("blocks fd00::/8 (ULA)", () => expect(isPrivateIp("fd00::1")).toBe(true));
  it("blocks fe80:: (link-local)", () => expect(isPrivateIp("fe80::1")).toBe(true));
  it("blocks ::ffff:127.0.0.1 (IPv4-mapped loopback)", () =>
    expect(isPrivateIp("::ffff:127.0.0.1")).toBe(true));
  it("blocks ::ffff:10.0.0.1 (IPv4-mapped private)", () =>
    expect(isPrivateIp("::ffff:10.0.0.1")).toBe(true));
  it("blocks ::ffff:192.168.1.1", () =>
    expect(isPrivateIp("::ffff:192.168.1.1")).toBe(true));
  it("blocks ::ffff:169.254.0.1 (IPv4-mapped link-local)", () =>
    expect(isPrivateIp("::ffff:169.254.0.1")).toBe(true));
});

// ── isPrivateIp — unknown / non-IP strings ────────────────────────────────────

describe("isPrivateIp — non-IP input", () => {
  it("treats a hostname string as private (safe default)", () =>
    expect(isPrivateIp("example.com")).toBe(true));
  it("treats empty string as private", () =>
    expect(isPrivateIp("")).toBe(true));
});

// ── fetchWithSsrfProtection — error body surfacing ────────────────────────────

import { afterEach, vi } from "vitest";
import { fetchWithSsrfProtection } from "../../lib/ssrf";

function mockFetchOnce(status: number, body: string) {
  const response = {
    status,
    ok: status >= 200 && status < 300,
    headers: { get: () => null },
    text: async () => body,
    body: null,
  };
  vi.stubGlobal("fetch", vi.fn(async () => response));
}

describe("fetchWithSsrfProtection — error body surfacing", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("appends the upstream body snippet when includeErrorBody is set", async () => {
    mockFetchOnce(503, "Twitter API is not configured");
    await expect(
      fetchWithSsrfProtection("http://rsshub:3000/twitter/user/x", {}, { allowInternal: true, includeErrorBody: true }),
    ).rejects.toThrow(/Fetch failed: 503 — Twitter API is not configured/);
  });

  it("keeps the terse error when includeErrorBody is off", async () => {
    mockFetchOnce(503, "Twitter API is not configured");
    await expect(
      fetchWithSsrfProtection("http://rsshub:3000/twitter/user/x", {}, { allowInternal: true }),
    ).rejects.toThrow(/^Fetch failed: 503$/);
  });

  it("strips HTML tags from an error page body", async () => {
    mockFetchOnce(404, "<html><body><h1>Not Found</h1></body></html>");
    await expect(
      fetchWithSsrfProtection("http://rsshub:3000/nope", {}, { allowInternal: true, includeErrorBody: true }),
    ).rejects.toThrow(/Fetch failed: 404 — Not Found/);
  });
});

describe("reserved addresses and mapped normalization", () => {
  it.each(["0.1.2.3", "192.0.0.1", "198.51.100.1", "203.0.113.1", "240.0.0.1", "::ffff:172.17.0.1", "::ffff:ac1f:ffff", "::ffff:100.64.0.1", "::ffff:0.0.0.0", "::ffff:192.0.0.1", "64:ff9b::a00:1", "2002:0808:0808::1", "fec0::1", "febf::1", "ff02::1", "2001:db8::1", "[::1]"])("blocks %s", ip => {
    expect(isPrivateIp(ip)).toBe(true);
  });
  it.each(["::ffff:8.8.8.8", "::ffff:808:808", "2001:4860:4860::8888", "2606:4700:4700::1111"])("allows %s", ip => {
    expect(isPrivateIp(ip)).toBe(false);
  });
});

describe("redirect credentials", () => {
  afterEach(() => vi.unstubAllGlobals());
  it.each([true, false])("cross origin = %s", async crossOrigin => {
    const seen: Headers[] = [];
    vi.stubGlobal("fetch", vi.fn(async (_url, init) => {
      seen.push(new Headers(init.headers));
      return seen.length === 1
        ? new Response(null, { status: 302, headers: { location: crossOrigin ? "https://other.test/final" : "/final" } })
        : new Response("ok");
    }));
    const headers = { Authorization: "Basic secret", Cookie: "session=secret", Accept: "text/plain" };
    await fetchWithSsrfProtection("https://start.test/", { headers }, { allowInternal: true });
    expect(seen[0].get("authorization")).toBe("Basic secret");
    expect(seen[1].get("authorization")).toBe(crossOrigin ? null : "Basic secret");
    expect(seen[1].get("cookie")).toBe(crossOrigin ? null : "session=secret");
    expect(seen[1].get("accept")).toBe("text/plain");
    expect(headers.Authorization).toBe("Basic secret");
  });
});
