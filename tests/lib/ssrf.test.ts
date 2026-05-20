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
});

describe("isPrivateIp — IPv4 public ranges", () => {
  it("allows 1.1.1.1 (Cloudflare DNS)", () => expect(isPrivateIp("1.1.1.1")).toBe(false));
  it("allows 8.8.8.8 (Google DNS)", () => expect(isPrivateIp("8.8.8.8")).toBe(false));
  it("allows 93.184.216.34 (example.com)", () => expect(isPrivateIp("93.184.216.34")).toBe(false));
  it("allows 172.15.0.1 (just below RFC 1918 range)", () => expect(isPrivateIp("172.15.255.255")).toBe(false));
  it("allows 172.32.0.1 (just above RFC 1918 range)", () => expect(isPrivateIp("172.32.0.0")).toBe(false));
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
