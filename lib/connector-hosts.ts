// Trusted optional-connector hosts (RSSHub, changedetection.io).
//
// These connectors are admin-configured services that, in the recommended
// deployment, run on the SAME private Docker network as FeedFerret — so their
// base URLs are private hostnames (e.g. http://rsshub:3000/). FeedFerret's
// SSRF guard blocks private/internal addresses by default, which would make
// these connectors unusable on their intended network unless the operator
// flips the blunt, instance-wide "allow internal feed URLs" switch (which
// would then let ANY user point ANY feed at internal addresses).
//
// Instead, the specific host[:port] of each *configured* connector is treated
// as trusted for internal access — narrowly, just those hosts — so a
// connector "just works" on the internal network without weakening SSRF for
// arbitrary feeds. A resolved RSSHub/changedetection.io feed is a plain feed
// URL pointing at that same trusted host, so this covers both the initial
// validation and every ongoing background sync of it.

import { db } from "@/lib/db";

function hostOf(rawUrl?: string | null): string | null {
  if (!rawUrl?.trim()) return null;
  try {
    return new URL(rawUrl.trim()).host.toLowerCase();
  } catch {
    return null;
  }
}

/**
 * The set of host[:port] values for every currently-configured optional
 * connector. ENV overrides (`FEEDFERRET_RSSHUB_URL` /
 * `FEEDFERRET_CHANGEDETECTION_URL`) are always included; DB-configured
 * connectors are included only when their `*Enabled` flag is on. Never throws.
 */
export async function getTrustedConnectorHosts(): Promise<Set<string>> {
  const hosts = new Set<string>();

  const envRsshub = hostOf(process.env.FEEDFERRET_RSSHUB_URL);
  if (envRsshub) hosts.add(envRsshub);
  const envChangedetection = hostOf(process.env.FEEDFERRET_CHANGEDETECTION_URL);
  if (envChangedetection) hosts.add(envChangedetection);

  try {
    const settings = await db.globalSettings.findUnique({
      where: { id: "global" },
      select: {
        rsshubEnabled: true,
        rsshubBaseUrl: true,
        changedetectionEnabled: true,
        changedetectionBaseUrl: true,
      },
    });
    if (settings?.rsshubEnabled) {
      const h = hostOf(settings.rsshubBaseUrl);
      if (h) hosts.add(h);
    }
    if (settings?.changedetectionEnabled) {
      const h = hostOf(settings.changedetectionBaseUrl);
      if (h) hosts.add(h);
    }
  } catch {
    // DB unavailable — fall back to whatever ENV gave us.
  }

  return hosts;
}

/** True when `rawUrl`'s host is one of the configured connectors' hosts. */
export async function isTrustedConnectorUrl(rawUrl: string): Promise<boolean> {
  const host = hostOf(rawUrl);
  if (!host) return false;
  return (await getTrustedConnectorHosts()).has(host);
}
