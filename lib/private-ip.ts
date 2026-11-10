import net from "node:net";

function isPrivateIpv4(ip: string) {
  const parts = ip.split(".").map(Number);
  const [a, b, c] = parts;
  return (
    a === 0 ||
    a === 10 ||
    a === 127 ||
    (a === 100 && b >= 64 && b <= 127) ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) ||
    // TEST-NET-1 (RFC 5737) — reserved for documentation, never publicly
    // routed. NOTE: this is 192.0.2.0/24, not all of 192.0.0.0/16 — the rest
    // of that /16 (e.g. 192.0.78.0/23, allocated to Automattic/WordPress.com)
    // is ordinary public space and must not be blocked here.
    (a === 192 && b === 0 && (c === 0 || c === 2)) ||
    (a === 192 && b === 88 && c === 99) ||
    (a === 198 && b === 51 && c === 100) ||
    (a === 203 && b === 0 && c === 113) ||
    (a === 198 && (b === 18 || b === 19)) ||
    a >= 224
  );
}

function isPrivateIpv6(ip: string) {
  // URL canonicalization handles compressed and dotted IPv4-mapped literals.
  let canonical: string;
  try {
    canonical = new URL(`http://[${ip}]/`).hostname.slice(1, -1);
  } catch {
    // Zone IDs and unsupported literals must fail closed, never escape guards.
    return true;
  }
  const halves = canonical.split("::");
  const left = halves[0] ? halves[0].split(":") : [];
  const right = halves[1] ? halves[1].split(":") : [];
  const words = [...left, ...Array(8 - left.length - right.length).fill("0"), ...right].map(v => parseInt(v, 16));
  if (words.slice(0, 5).every(v => v === 0) && words[5] === 0xffff) {
    return isPrivateIpv4(`${words[6] >> 8}.${words[6] & 255}.${words[7] >> 8}.${words[7] & 255}`);
  }
  // Only global unicast 2000::/3, excluding special-purpose assignments.
  // This also rejects NAT64 (64:ff9b::/96), ULA, site/link-local and multicast.
  return (words[0] & 0xe000) !== 0x2000 ||
    (words[0] === 0x2001 && (words[1] < 0x200 || words[1] === 0xdb8)) ||
    words[0] === 0x2002 || (words[0] === 0x3fff && words[1] < 0x1000);
}

export function isPrivateIp(ip: string) {
  const normalized = ip.replace(/^\[|\]$/g, "");
  const version = net.isIP(normalized);
  if (version === 4) return isPrivateIpv4(normalized);
  if (version === 6) return isPrivateIpv6(normalized);
  return true;
}
