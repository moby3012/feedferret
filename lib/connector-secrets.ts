// Connector access secrets stay server-side (security audit #2, N3 / M4).
//
// The admin-configured RSSHub `?key=` and changedetection.io `?token=` used to
// be baked into stored feed URLs, so every feed list, preview response, OPML
// export and fetch error handed them to ordinary users. Now:
//
// - Stored feed URLs are secret-free (`stripConnectorSecrets` at create time).
// - The fetcher adds the current secret right before the request
//   (`applyConnectorSecrets`), only for URLs on the configured connector's
//   origin + base path, so a key rotation needs no feed rewrite either.
// - Every client-facing output additionally runs through `redactConnectorUrl`
//   / `redactConnectorText` (defence in depth for rows that could not be
//   migrated, e.g. a keyless duplicate already existed).
// - `migrateConnectorFeedUrls` rewrites legacy keyed rows once at startup.
//   It is idempotent: it only strips a param whose value equals the currently
//   configured secret (so re-adding it at fetch time reproduces the exact
//   former URL), and skips a row whose keyless URL already exists for the user.

import { logger } from "@/lib/logger";

export type ConnectorSecretRule = {
  /** e.g. "http://rsshub:1200" */
  origin: string;
  /** Base path of the instance without trailing slash ("" for a root install). */
  basePath: string;
  /** Query parameter carrying the secret. */
  param: string;
  /** Current secret, or null when the connector needs none. */
  value: string | null;
};

function ruleFor(baseUrl: string, param: string, value: string | null): ConnectorSecretRule | null {
  try {
    const base = new URL(baseUrl);
    return { origin: base.origin, basePath: base.pathname.replace(/\/+$/, ""), param, value };
  } catch {
    return null;
  }
}

const RULES_TTL_MS = 15_000;
let rulesCache: { at: number; rules: ConnectorSecretRule[] } | null = null;

/** Rules for every configured connector (15 s memo: the fetcher asks once per feed fetch). Never throws. */
export async function getConnectorSecretRules(): Promise<ConnectorSecretRule[]> {
  if (rulesCache && Date.now() - rulesCache.at < RULES_TTL_MS) return rulesCache.rules;
  const rules: ConnectorSecretRule[] = [];
  // Dynamic imports: lib/rsshub imports the feed fetcher, which imports this module.
  const [{ getRsshubConfig }, { getChangedetectionConfig }] = await Promise.all([
    import("@/lib/rsshub"),
    import("@/lib/changedetection"),
  ]);
  const [rsshub, changedetection] = await Promise.all([
    getRsshubConfig().catch(() => null),
    getChangedetectionConfig().catch(() => null),
  ]);
  if (rsshub) {
    const rule = ruleFor(rsshub.baseUrl, "key", rsshub.apiKey);
    if (rule) rules.push(rule);
  }
  if (changedetection) {
    const rule = ruleFor(changedetection.baseUrl, "token", changedetection.rssToken);
    if (rule) rules.push(rule);
  }
  rulesCache = { at: Date.now(), rules };
  return rules;
}

/** Test hook: forget the memoized rules. */
export function resetConnectorSecretRulesCache() {
  rulesCache = null;
}

function matches(url: URL, rule: ConnectorSecretRule): boolean {
  if (url.origin !== rule.origin) return false;
  if (!rule.basePath) return true;
  return url.pathname === rule.basePath || url.pathname.startsWith(`${rule.basePath}/`);
}

function parse(rawUrl: string): URL | null {
  try {
    return new URL(rawUrl);
  } catch {
    return null;
  }
}

/** Removes connector secret params from a URL on a connector host (any value). Other URLs unchanged. */
export function stripConnectorSecretsWith(rules: ConnectorSecretRule[], rawUrl: string): string {
  const url = parse(rawUrl);
  if (!url) return rawUrl;
  let changed = false;
  for (const rule of rules) {
    if (matches(url, rule) && url.searchParams.has(rule.param)) {
      url.searchParams.delete(rule.param);
      changed = true;
    }
  }
  return changed ? url.toString() : rawUrl;
}

/** Adds the current connector secret to a URL on a connector host (overriding any stale value). */
export function applyConnectorSecretsWith(rules: ConnectorSecretRule[], rawUrl: string): string {
  const url = parse(rawUrl);
  if (!url) return rawUrl;
  let changed = false;
  for (const rule of rules) {
    if (!rule.value || !matches(url, rule)) continue;
    if (url.searchParams.get(rule.param) === rule.value) continue;
    url.searchParams.set(rule.param, rule.value);
    changed = true;
  }
  return changed ? url.toString() : rawUrl;
}

/** Replaces every configured secret value occurring in free text (errors, logs) with "***". */
export function redactConnectorTextWith(rules: ConnectorSecretRule[], text: string): string {
  let out = text;
  for (const rule of rules) {
    if (!rule.value || rule.value.length < 4) continue;
    out = out.split(rule.value).join("***");
    const encoded = encodeURIComponent(rule.value);
    if (encoded !== rule.value) out = out.split(encoded).join("***");
  }
  return out;
}

export async function stripConnectorSecrets(rawUrl: string): Promise<string> {
  return stripConnectorSecretsWith(await getConnectorSecretRules(), rawUrl);
}

export async function applyConnectorSecrets(rawUrl: string): Promise<string> {
  return applyConnectorSecretsWith(await getConnectorSecretRules(), rawUrl);
}

/**
 * Client-facing view of feed rows: URL without connector secrets, lastError
 * without secret values. Accepts any object with `url` (and optional
 * `lastError`); returns new objects, never mutates.
 */
export async function redactFeedsForClient<T extends { url?: string | null; lastError?: string | null }>(feeds: T[]): Promise<T[]> {
  const rules = await getConnectorSecretRules();
  if (!rules.length) return feeds;
  return feeds.map((feed) => redactFeedWith(rules, feed));
}

export async function redactFeedForClient<T extends { url?: string | null; lastError?: string | null }>(feed: T): Promise<T> {
  if (!feed) return feed;
  const rules = await getConnectorSecretRules();
  if (!rules.length) return feed;
  return redactFeedWith(rules, feed);
}

export function redactFeedWith<T extends { url?: string | null; lastError?: string | null }>(rules: ConnectorSecretRule[], feed: T): T {
  if (!feed || typeof feed !== "object") return feed;
  const out = { ...feed };
  if (typeof out.url === "string") out.url = stripConnectorSecretsWith(rules, out.url);
  if (typeof out.lastError === "string") out.lastError = redactConnectorTextWith(rules, out.lastError);
  return out;
}

type FeedUrlRow = { id: string; userId: string; url: string };
type MigrationDb = {
  feed: {
    findMany(args: unknown): Promise<FeedUrlRow[]>;
    findFirst(args: unknown): Promise<{ id: string } | null>;
    update(args: unknown): Promise<unknown>;
  };
};

/**
 * One-off, idempotent rewrite of legacy keyed connector feed URLs to their
 * secret-free form. Only strips a param whose value equals the configured
 * secret; skips rows whose stripped URL already exists for the same user
 * (the @@unique([userId, url]) would reject it — output redaction still
 * covers those). Returns counts; never throws.
 */
export async function migrateConnectorFeedUrls(db: MigrationDb, rulesInput?: ConnectorSecretRule[]) {
  const result = { scanned: 0, migrated: 0, skipped: 0 };
  try {
    const rules = (rulesInput ?? (await getConnectorSecretRules())).filter((rule) => rule.value);
    for (const rule of rules) {
      const candidates = await db.feed.findMany({
        where: { url: { startsWith: `${rule.origin}${rule.basePath}`, contains: `${rule.param}=` } },
        select: { id: true, userId: true, url: true },
      });
      for (const feed of candidates) {
        result.scanned += 1;
        const url = parse(feed.url);
        if (!url || !matches(url, rule) || url.searchParams.get(rule.param) !== rule.value) continue;
        url.searchParams.delete(rule.param);
        const stripped = url.toString();
        const clash = await db.feed.findFirst({ where: { userId: feed.userId, url: stripped }, select: { id: true } });
        if (clash) {
          result.skipped += 1;
          continue;
        }
        try {
          await db.feed.update({ where: { id: feed.id }, data: { url: stripped } });
          result.migrated += 1;
        } catch {
          result.skipped += 1;
        }
      }
    }
  } catch (error) {
    logger.warn("[connector-secrets] feed URL migration failed; secrets stay redacted on output", error);
  }
  return result;
}
