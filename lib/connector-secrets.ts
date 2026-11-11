import { redact } from "./redact";
// Connector access secrets stay server-side (security audit #2, N3 / M4).
//
// The admin-configured RSSHub `?key=` and changedetection.io `?token=` used to
// be baked into stored feed URLs, so every feed list, preview response, OPML
// export and fetch error handed them to ordinary users. Now:
//
// - Stored feed URLs are secret-free (`stripConnectorSecrets` at create time).
// - The fetcher adds the current secret right before the request
//   (`resolveConnectorRequest`), and only for an allowed feed route on the
//   configured connector's origin + base path: an ordinary RSSHub platform
//   route (`rsshubRouteError`) or a single changedetection.io watch feed.
//   Only those URLs are also allowed onto the internal network. Anything else
//   on the connector host (`/rsshub/transform/…`, `/api/…`, changedetection's
//   all-watches `/rss`) gets neither the secret nor internal access, so a user
//   can't turn the connector into a read-SSRF proxy with the admin's key.
//   Create paths refuse such URLs up front (`connectorFeedUrlError`).
// - Every client-facing output additionally runs through `redactFeed*`
//   / `redactConnectorText` (defence in depth for rows that still carry the
//   secret, e.g. before the migration below runs).
// - `scrubConnectorSecretsFromArticleLinks` removes secrets from stored
//   (synthetic) article links on every start. Always on: no build ever used
//   an article link as a fetch URL, so a rollback is unaffected.
// - `migrateConnectorFeedUrls` rewrites legacy keyed feed rows to the keyless
//   form. Opt-in for this release (`FEEDFERRET_MIGRATE_CONNECTOR_URLS=1`) so a
//   rollback to an older build, which still expects keyed URLs, keeps
//   working. Injection and redaction work for keyed and keyless rows alike.
// - A user-chosen proxy never sees the secret: with CURLOPT_PROXY set the
//   fetcher requests the keyless URL as an ordinary external fetch.

import { logger } from "@/lib/logger";
import { changedetectionRouteError, rsshubRouteError } from "@/lib/rsshub-route";

export type ConnectorKind = "rsshub" | "changedetection";

export type ConnectorSecretRule = {
  kind: ConnectorKind;
  /** e.g. "http://rsshub:1200" */
  origin: string;
  /** Base path of the instance without trailing slash ("" for a root install). */
  basePath: string;
  /** Query parameter carrying the secret. */
  param: string;
  /** Current secret, or null when the connector needs none. */
  value: string | null;
};

function ruleFor(kind: ConnectorKind, baseUrl: string, param: string, value: string | null): ConnectorSecretRule | null {
  try {
    const base = new URL(baseUrl);
    return { kind, origin: base.origin, basePath: base.pathname.replace(/\/+$/, ""), param, value };
  } catch {
    return null;
  }
}

const RULES_TTL_MS = 15_000;
let rulesCache: { at: number; rules: ConnectorSecretRule[] } | null = null;
/** Per-connector rule from the last successful config read (fallback while the DB hiccups). */
const lastGoodRules = new Map<ConnectorKind, ConnectorSecretRule | null>();

/**
 * Rules for every configured connector (15 s memo: the fetcher asks once per
 * feed fetch). Never throws. A config read that failed (DB hiccup) is not
 * memoized, so it can't blank out redaction/injection for the whole TTL, and
 * the failed connector falls back to its last successfully loaded rule so
 * output redaction keeps working meanwhile.
 */
export async function getConnectorSecretRules(): Promise<ConnectorSecretRule[]> {
  if (rulesCache && Date.now() - rulesCache.at < RULES_TTL_MS) return rulesCache.rules;
  let failed = false;
  const settle = <T>(promise: Promise<T>) =>
    promise.then(
      (value) => ({ ok: true as const, value }),
      (error) => {
        failed = true;
        logger.warn("[connector-secrets] connector config unavailable", error);
        return { ok: false as const, value: null };
      },
    );
  // Dynamic imports: lib/rsshub imports the feed fetcher, which imports this module.
  const [{ loadRsshubConfig }, { loadChangedetectionConfig }] = await Promise.all([
    import("@/lib/rsshub"),
    import("@/lib/changedetection"),
  ]);
  const [rsshub, changedetection] = await Promise.all([settle(loadRsshubConfig()), settle(loadChangedetectionConfig())]);
  const resolved: Array<[ConnectorKind, ConnectorSecretRule | null]> = [];
  if (rsshub.ok) resolved.push(["rsshub", rsshub.value ? ruleFor("rsshub", rsshub.value.baseUrl, "key", rsshub.value.apiKey) : null]);
  else resolved.push(["rsshub", lastGoodRules.get("rsshub") ?? null]);
  if (changedetection.ok) {
    resolved.push([
      "changedetection",
      changedetection.value ? ruleFor("changedetection", changedetection.value.baseUrl, "token", changedetection.value.rssToken) : null,
    ]);
  } else {
    resolved.push(["changedetection", lastGoodRules.get("changedetection") ?? null]);
  }
  if (rsshub.ok) lastGoodRules.set("rsshub", resolved[0][1]);
  if (changedetection.ok) lastGoodRules.set("changedetection", resolved[1][1]);
  const rules = resolved.map(([, rule]) => rule).filter((rule): rule is ConnectorSecretRule => rule !== null);
  rulesCache = failed ? null : { at: Date.now(), rules };
  return rules;
}

/** Forget the memoized rules (tests; admin save of the RSSHub / changedetection.io settings). */
export function resetConnectorSecretRulesCache(options: { includeLastGood?: boolean } = {}) {
  rulesCache = null;
  if (options.includeLastGood) lastGoodRules.clear();
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

/**
 * Why `url` (already known to be on `rule`'s origin + base path) is not an
 * allowed feed route for that connector, or null when it is. The secret
 * param itself is ignored (legacy rows still carry it).
 */
function routeErrorFor(rule: ConnectorSecretRule, url: URL): string | null {
  const route = url.pathname.slice(rule.basePath.length) || "/";
  const query = new URLSearchParams(url.search);
  query.delete(rule.param);
  if (rule.kind === "changedetection") return changedetectionRouteError(route, query);
  const search = query.toString();
  return rsshubRouteError(search ? `${route}?${search}` : route);
}

/**
 * Create-time gate: an error message when `rawUrl` points at a configured
 * connector but not at an allowed feed route there; null otherwise (including
 * every non-connector URL).
 */
export function connectorFeedUrlErrorWith(rules: ConnectorSecretRule[], rawUrl: string): string | null {
  const url = parse(rawUrl);
  if (!url) return null;
  for (const rule of rules) {
    if (!matches(url, rule)) continue;
    const error = routeErrorFor(rule, url);
    if (error) return error;
  }
  return null;
}

export async function connectorFeedUrlError(rawUrl: string): Promise<string | null> {
  return connectorFeedUrlErrorWith(await getConnectorSecretRules(), rawUrl);
}

export type ConnectorRequest = {
  /** URL to request (with the current secret when it is an allowed connector route). */
  url: string;
  /** True only for an allowed route on a configured connector: may reach the internal network. */
  trusted: boolean;
};

/** Fetch-time policy for a feed URL (pure part of `resolveConnectorRequest`). */
export function resolveConnectorRequestWith(rules: ConnectorSecretRule[], rawUrl: string): ConnectorRequest {
  const url = parse(rawUrl);
  if (!url) return { url: rawUrl, trusted: false };
  let trusted = false;
  let changed = false;
  for (const rule of rules) {
    if (!matches(url, rule)) continue;
    // Not an allowed route: never trusted, and a legacy stored secret is stripped so it
    // can't travel to a disallowed path (or through a user-chosen proxy).
    if (routeErrorFor(rule, url)) return { url: stripConnectorSecretsWith(rules, rawUrl), trusted: false };
    trusted = true;
    if (rule.value && url.searchParams.get(rule.param) !== rule.value) {
      url.searchParams.set(rule.param, rule.value);
      changed = true;
    }
  }
  return { url: changed ? url.toString() : rawUrl, trusted };
}

export async function resolveConnectorRequest(rawUrl: string): Promise<ConnectorRequest> {
  return resolveConnectorRequestWith(await getConnectorSecretRules(), rawUrl);
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

/** Adds the current connector secret to an allowed connector route (overriding any stale value). */
export function applyConnectorSecretsWith(rules: ConnectorSecretRule[], rawUrl: string): string {
  return resolveConnectorRequestWith(rules, rawUrl).url;
}

/** Replaces every configured secret value occurring in free text (errors, logs) with "***". */
export function redactConnectorTextWith(rules: ConnectorSecretRule[], text: string): string {
  let out = redact(text);
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

/**
 * Client-facing view of article rows: `link` without connector secrets
 * (linkless items of legacy rows used `<keyed feed url>#<dedupe key>`) and the
 * nested `feed` (if any) redacted like `redactFeedWith`. New objects, never mutates.
 */
export function redactArticleWith<T>(rules: ConnectorSecretRule[], article: T): T {
  if (!rules.length || !article || typeof article !== "object") return article;
  const out = { ...article } as Record<string, unknown>;
  if (typeof out.link === "string") out.link = stripConnectorSecretsWith(rules, out.link);
  if (out.feed && typeof out.feed === "object") out.feed = redactFeedWith(rules, out.feed as { url?: string | null; lastError?: string | null });
  return out as T;
}

export async function redactArticlesForClient<T>(articles: T[]): Promise<T[]> {
  const rules = await getConnectorSecretRules();
  if (!rules.length) return articles;
  return articles.map((article) => redactArticleWith(rules, article));
}

export async function redactArticleForClient<T>(article: T): Promise<T> {
  if (!article) return article;
  return redactArticleWith(await getConnectorSecretRules(), article);
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
 * secret-free form. Strips the secret param whatever its value (a key that
 * was rotated since is dead weight; the fetcher sets the current one), skips
 * rows whose stripped URL already exists for the same user (the
 * @@unique([userId, url]) would reject it — output redaction still covers
 * those). Returns counts; never throws.
 */
export async function migrateConnectorFeedUrls(db: MigrationDb, rulesInput?: ConnectorSecretRule[]) {
  const result = { scanned: 0, migrated: 0, skipped: 0 };
  try {
    const rules = rulesInput ?? (await getConnectorSecretRules());
    for (const rule of rules) {
      const candidates = await db.feed.findMany({
        where: { url: { startsWith: `${rule.origin}${rule.basePath}`, contains: `${rule.param}=` } },
        select: { id: true, userId: true, url: true },
      });
      for (const feed of candidates) {
        result.scanned += 1;
        const url = parse(feed.url);
        if (!url || !matches(url, rule) || !url.searchParams.has(rule.param)) continue;
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

/**
 * Opt-in for this release: rewriting stored feed URLs is not
 * rolled back by downgrading, and an older build expects keyed URLs. Enable
 * with `FEEDFERRET_MIGRATE_CONNECTOR_URLS=1` (planned default-on next release).
 */
export function connectorUrlMigrationEnabled(env: Record<string, string | undefined> = process.env): boolean {
  return ["1", "true", "yes", "on"].includes(String(env.FEEDFERRET_MIGRATE_CONNECTOR_URLS ?? "").trim().toLowerCase());
}

type ArticleLinkRow = { id: string; link: string; updatedAt: Date };
type ArticleScrubDb = {
  feed: { findMany(args: unknown): Promise<Array<{ id: string }>> };
  article: {
    findMany(args: unknown): Promise<ArticleLinkRow[]>;
    updateMany(args: unknown): Promise<{ count: number }>;
  };
};

/**
 * Idempotent background cleanup: removes the connector secret from stored
 * article links (linkless items used to get `<keyed feed url>#<dedupe key>`).
 * Runs on every start, not behind the feed URL migration flag: older builds
 * never fetch article links, so this is rollback-safe.
 *
 * Bounded: only articles of feeds on a connector origin are looked at (via the
 * Article feedId index, chunks of feed ids), only rows whose link starts with
 * the connector origin + base path and contains `<param>=`, batched by id
 * cursor with a yield between batches. Keeps Article.updatedAt unchanged
 * (GReader ot/nt sync depends on it). Returns counts; never throws.
 */
export async function scrubConnectorSecretsFromArticleLinks(
  db: ArticleScrubDb,
  rulesInput?: ConnectorSecretRule[],
  batchSize = 500,
  feedChunkSize = 200,
) {
  const result = { scanned: 0, scrubbed: 0 };
  try {
    const rules = rulesInput ?? (await getConnectorSecretRules());
    for (const rule of rules) {
      const prefix = `${rule.origin}${rule.basePath}`;
      const feeds = await db.feed.findMany({ where: { url: { startsWith: prefix } }, select: { id: true } });
      for (let i = 0; i < feeds.length; i += feedChunkSize) {
        const feedIds = feeds.slice(i, i + feedChunkSize).map((feed) => feed.id);
        let cursor: string | null = null;
        for (;;) {
          const rows: ArticleLinkRow[] = await db.article.findMany({
            where: {
              feedId: { in: feedIds },
              link: { startsWith: prefix, contains: `${rule.param}=` },
              ...(cursor ? { id: { gt: cursor } } : {}),
            },
            select: { id: true, link: true, updatedAt: true },
            orderBy: { id: "asc" },
            take: batchSize,
          });
          if (!rows.length) break;
          for (const row of rows) {
            result.scanned += 1;
            const scrubbed = stripConnectorSecretsWith([rule], row.link);
            if (scrubbed === row.link) continue;
            // Explicit updatedAt overrides @updatedAt: the row's sync clock stays as it was.
            // Conditional on the row being unchanged since it was read, so a concurrent sync
            // update (newer updatedAt / link) is never rolled back.
            const { count } = await db.article.updateMany({
              where: { id: row.id, link: row.link, updatedAt: row.updatedAt },
              data: { link: scrubbed, updatedAt: row.updatedAt },
            });
            result.scrubbed += count;
          }
          cursor = rows[rows.length - 1].id;
          if (rows.length < batchSize) break;
          await new Promise((resolve) => setImmediate(resolve));
        }
        await new Promise((resolve) => setImmediate(resolve));
      }
    }
  } catch (error) {
    logger.warn("[connector-secrets] article link cleanup failed; will retry on next start", error);
  }
  return result;
}
