/**
 * Client address resolution for rate limits and the sign-in audit log.
 *
 * Two inputs, in order of trust:
 *  1. The TCP peer (`scripts/peer-address-preload.cjs` stamps it on every request as
 *     `x-feedferret-peer: <per-process token>|<address>`, overwriting anything the client sent; without
 *     the matching token the header is ignored). Unavailable under `next dev` / plain `next start`.
 *  2. `X-Forwarded-For` / `X-Real-IP`, which a client can forge unless a trusted proxy overwrites or
 *     appends to them.
 *
 * Policy (`TRUSTED_PROXY_COUNT`, `TRUSTED_PROXIES`):
 *  - `0` = no proxy: the peer is the client, forwarded headers are ignored.
 *  - `n >= 1` (set explicitly = "a proxy of mine sits in front"): forwarded headers are used only when
 *    the direct peer is a trusted proxy. With `TRUSTED_PROXIES` set (comma separated IPs / CIDRs) that
 *    list alone decides; without it loopback, RFC 1918 private, link-local and ULA peers are assumed to
 *    be the proxy (the Docker network of Coolify/Traefik, Nginx, Caddy). CGNAT (100.64/10, Tailscale)
 *    is NOT assumed: tailnet peers are far more often clients than proxies. A public or unlisted peer is
 *    a direct client, so a spoofed `X-Forwarded-For` cannot choose its limiter key. The n-th entry from
 *    the right is the client. Without peer information (no preload: `next dev`, `next start`) the
 *    operator's explicit count is taken at its word.
 *  - unset / empty / invalid (LEGACY, warned loudly): behaves like `1` for compatibility with installs
 *    that never set it. This still trusts any private peer (and, without peer information, every
 *    header), so a directly exposed instance (LAN client, Docker userland proxy presenting as
 *    172.17.0.1) lets clients pick their key: set the variable. Failing closed instead would key all
 *    clients "unknown" and let one user lock everybody out of sign-in.
 *
 * IPv6 clients are keyed by their /64 (every VPS gets one for free; per-address keys would let one
 * host mint unlimited limiter keys) and IPv4-mapped IPv6 addresses by their IPv4 address.
 */

const PEER_HEADER = "x-feedferret-peer";

interface ParsedIp { version: 4 | 6; value: bigint }

function parseIpv4(text: string): bigint | null {
  const parts = text.split(".");
  if (parts.length !== 4) return null;
  let value = BigInt(0);
  for (const part of parts) {
    if (!/^\d{1,3}$/.test(part)) return null;
    const n = Number(part);
    if (n > 255) return null;
    value = (value << BigInt(8)) | BigInt(n);
  }
  return value;
}

function parseIpv6(text: string): bigint | null {
  let source = text;
  const zone = source.indexOf("%");
  if (zone >= 0) source = source.slice(0, zone);
  if (!source.includes(":")) return null;
  // Embedded IPv4 tail (::ffff:1.2.3.4) becomes two groups.
  const lastColon = source.lastIndexOf(":");
  if (source.slice(lastColon + 1).includes(".")) {
    const v4 = parseIpv4(source.slice(lastColon + 1));
    if (v4 === null) return null;
    source = `${source.slice(0, lastColon + 1)}${(v4 >> BigInt(16)).toString(16)}:${(v4 & BigInt(0xffff)).toString(16)}`;
  }
  const halves = source.split("::");
  if (halves.length > 2) return null;
  const head = halves[0] ? halves[0].split(":") : [];
  const tail = halves.length === 2 && halves[1] ? halves[1].split(":") : [];
  if (halves.length === 1 ? head.length !== 8 : head.length + tail.length > 7) return null;
  const groups = halves.length === 1 ? head : [...head, ...Array<string>(8 - head.length - tail.length).fill("0"), ...tail];
  let value = BigInt(0);
  for (const group of groups) {
    if (!/^[0-9a-f]{1,4}$/i.test(group)) return null;
    value = (value << BigInt(16)) | BigInt(`0x${group}`);
  }
  return value;
}

export function parseIp(text: string): ParsedIp | null {
  let source = text.trim();
  if (source.startsWith("[") && source.includes("]")) source = source.slice(1, source.indexOf("]"));
  const v4 = parseIpv4(source);
  if (v4 !== null) return { version: 4, value: v4 };
  const v6 = parseIpv6(source);
  if (v6 === null) return null;
  // IPv4-mapped (::ffff:a.b.c.d) is the same host as a.b.c.d.
  if (v6 >> BigInt(32) === BigInt(0xffff)) return { version: 4, value: v6 & BigInt(0xffffffff) };
  return { version: 6, value: v6 };
}

function formatIpv4(value: bigint): string {
  return [BigInt(24), BigInt(16), BigInt(8), BigInt(0)].map((shift) => String((value >> shift) & BigInt(0xff))).join(".");
}

function formatIpv6(value: bigint): string {
  return Array.from({ length: 8 }, (_, i) => ((value >> BigInt(112 - i * 16)) & BigInt(0xffff)).toString(16)).join(":");
}

/** Full address, canonical (for audit logs). Unparsable values pass through, truncated. */
export function normalizeIp(text: string): string {
  const parsed = parseIp(text);
  if (!parsed) return text.trim().slice(0, 64) || "unknown";
  return parsed.version === 4 ? formatIpv4(parsed.value) : formatIpv6(parsed.value);
}

/** Limiter key part: IPv6 collapses to its /64 prefix, everything else as `normalizeIp`. */
export function ipLimiterKey(text: string): string {
  const parsed = parseIp(text);
  if (!parsed) return text.trim().slice(0, 64) || "unknown";
  if (parsed.version === 4) return formatIpv4(parsed.value);
  return `${formatIpv6(parsed.value >> BigInt(64) << BigInt(64)).split(":").slice(0, 4).join(":")}::/64`;
}

function inRange(ip: ParsedIp, version: 4 | 6, base: string, bits: number): boolean {
  const parsed = parseIp(base);
  if (!parsed || parsed.version !== version || ip.version !== version) return false;
  const total = version === 4 ? BigInt(32) : BigInt(128);
  const shift = total - BigInt(bits);
  return ip.value >> shift === parsed.value >> shift;
}

const PRIVATE_RANGES: Array<[4 | 6, string, number]> = [
  [4, "127.0.0.0", 8], [4, "10.0.0.0", 8], [4, "172.16.0.0", 12], [4, "192.168.0.0", 16],
  [4, "169.254.0.0", 16],
  [6, "::1", 128], [6, "fc00::", 7], [6, "fe80::", 10],
];

function trustedProxyList(): Array<{ version: 4 | 6; base: string; bits: number }> {
  const out: Array<{ version: 4 | 6; base: string; bits: number }> = [];
  for (const entry of (process.env.TRUSTED_PROXIES ?? "").split(",").map((v) => v.trim()).filter(Boolean)) {
    const [address, prefix] = entry.split("/");
    const parsed = parseIp(address);
    if (!parsed) continue;
    const max = parsed.version === 4 ? 32 : 128;
    const bits = prefix === undefined ? max : Number(prefix);
    if (!Number.isInteger(bits) || bits < 0 || bits > max) continue;
    out.push({ version: parsed.version, base: address, bits });
  }
  return out;
}

/**
 * Whether a direct peer is a reverse proxy whose forwarded headers are believable: `TRUSTED_PROXIES`
 * decides alone when set, otherwise loopback / private / link-local / ULA (never CGNAT).
 */
export function isTrustedProxyPeer(peer: string): boolean {
  const ip = parseIp(peer);
  if (!ip) return false;
  const listed = trustedProxyList();
  if (listed.length > 0) return listed.some(({ version, base, bits }) => inRange(ip, version, base, bits));
  return PRIVATE_RANGES.some(([version, base, bits]) => inRange(ip, version, base, bits));
}

/** Direct TCP peer stamped by the server preload, or null when unavailable / unauthentic. */
export function getPeerAddress(request: Request): string | null {
  const token = process.env.FEEDFERRET_PEER_TOKEN;
  if (!token) return null;
  const value = request.headers.get(PEER_HEADER);
  if (!value?.startsWith(`${token}|`)) return null;
  const peer = value.slice(token.length + 1);
  return peer ? normalizeIp(peer) : null;
}

type ProxyCount = { count: number; explicit: boolean };
function proxyCount(): ProxyCount {
  const raw = process.env.TRUSTED_PROXY_COUNT;
  if (raw === undefined || raw.trim() === "") return { count: 1, explicit: false };
  const n = Number(raw);
  if (Number.isSafeInteger(n) && n >= 0) return { count: n, explicit: true };
  return { count: 1, explicit: false };
}

/** Whether TRUSTED_PROXY_COUNT holds a valid value (0 included). */
export function isProxyCountExplicit(): boolean {
  return proxyCount().explicit;
}

const warned = new Set<string>();
function warnOnce(key: string, message: string) {
  if (warned.has(key)) return;
  warned.add(key);
  console.warn(message);
}

/** The startup / first-request text for an unset or invalid TRUSTED_PROXY_COUNT (also used by instrumentation). */
export function proxyCountUnsetWarning(): string {
  const raw = process.env.TRUSTED_PROXY_COUNT;
  return `TRUSTED_PROXY_COUNT is ${raw === undefined || raw.trim() === "" ? "not set" : `invalid ("${raw}")`}: legacy mode. ` +
    "Any private-network peer (LAN, Docker NAT such as 172.17.0.1) is believed when it sends X-Forwarded-For, so if FeedFerret is reachable without a reverse proxy in front, clients can choose their own rate-limit key. " +
    "Set TRUSTED_PROXY_COUNT=1 behind a single reverse proxy (Coolify/Traefik, Nginx, Caddy; 2 behind Cloudflare → Traefik) or TRUSTED_PROXY_COUNT=0 when exposed directly; see docs/reverse-proxy.md. This legacy fallback will be removed.";
}

/** Logs once when requests carry `X-Forwarded-For` while TRUSTED_PROXY_COUNT is unset/invalid. */
export function warnIfProxyCountUnset(): void {
  if (proxyCount().explicit) return;
  warnOnce("count-unset", `[rate-limit] ${proxyCountUnsetWarning()}`);
}

/** Test hook: lets the one-time warnings fire again. */
export function resetProxyCountWarning(): void {
  warned.clear();
}

/** Canonical client address (not collapsed to a /64): audit log value. */
export function getClientIp(request: Request): string {
  const { count, explicit } = proxyCount();
  const forwarded = request.headers.get("x-forwarded-for");
  if (forwarded && !explicit) warnIfProxyCountUnset();
  const peer = getPeerAddress(request);
  if (explicit && count === 0) {
    if (peer) return peer;
    warnOnce("no-peer", "[rate-limit] TRUSTED_PROXY_COUNT=0 needs the TCP peer address, which is only available through scripts/peer-address-preload.cjs (the Docker image loads it); falling back to a shared client key.");
    return "unknown";
  }
  if (peer) {
    if (!isTrustedProxyPeer(peer)) {
      if (forwarded) {
        warnOnce("untrusted-peer",
          "[rate-limit] Ignoring X-Forwarded-For from a direct peer that is not a trusted proxy. If FeedFerret runs behind a reverse proxy at that address, list it in TRUSTED_PROXIES (comma separated IPs/CIDRs; when set it replaces the private-network default); with no proxy set TRUSTED_PROXY_COUNT=0.");
      }
      return peer;
    }
  } else if (!explicit) {
    // Legacy mode without peer information (`pnpm start`/`next start` without the preload, tests):
    // failing closed would key every client "unknown", i.e. one user could lock everybody out of
    // sign-in. Keep believing the headers (as before this hardening) and say so.
    warnOnce("no-peer-unset", "[rate-limit] No TCP peer information (scripts/peer-address-preload.cjs is not loaded) and TRUSTED_PROXY_COUNT is not set: forwarded headers are believed without being able to check who sent them. Set TRUSTED_PROXY_COUNT (1 behind one reverse proxy, 0 when exposed directly) and start the server with the preload.");
  }
  if (forwarded) {
    const hops = forwarded.split(",").map((hop) => hop.trim());
    const hop = hops[Math.max(0, hops.length - Math.max(1, count))];
    return hop ? normalizeIp(hop) : peer ?? "unknown";
  }
  const realIp = request.headers.get("x-real-ip");
  if (realIp) return normalizeIp(realIp);
  return peer ?? "unknown";
}

/** `ip:<address or IPv6 /64>`: the limiter key for a request without a signed-in user. */
export function getClientIpKey(request: Request): string {
  return `ip:${ipLimiterKey(getClientIp(request))}`;
}
