import { createHmac, randomBytes } from "crypto";
import { FetchRedirectError, safeFetch, assertSafeFetchUrl, isTrustedFeedFetchingAllowed } from "@/lib/ssrf";
import { urlForLog } from "@/lib/logger";
import { WEBHOOK_HEADER_PURPOSE, WEBHOOK_SECRET_PURPOSE, openSecret, warnSecretOnce } from "@/lib/secret-box";

export type WebhookConfig = {
  url: string;
  method?: "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
  headers?: Record<string, string>;
  bodyTemplate?: string;
  secret?: string;
};

export type WebhookExecutionResult = {
  ok: boolean;
  status: number | null;
  error: string | null;
};

export function generateWebhookSecret(): string {
  return randomBytes(32).toString("hex");
}

export function signPayload(secret: string, body: string): string {
  return "sha256=" + createHmac("sha256", secret).update(body).digest("hex");
}

export function verifyWebhookSignature(secret: string, body: string, signature: string): boolean {
  const expected = signPayload(secret, body);
  return signature === expected;
}

export type InterpolationEncoding = "raw" | "json" | "url";

function encodeValue(value: string, encoding: InterpolationEncoding): string {
  if (encoding === "json") return JSON.stringify(value).slice(1, -1);
  if (encoding === "url") return encodeURIComponent(value);
  return value;
}

/**
 * Substitute `{{var}}` placeholders in a template.
 * Unknown keys are left as the literal string `{{key}}` so the user can
 * spot typos in the request log instead of getting an empty value.
 *
 * Values come from feeds (article titles, feed names) — i.e. from whoever
 * publishes the feed — so they are encoded for the target context (N5):
 * `json` escapes them as the inside of a JSON string literal (a title like
 * `x","rule":"deploy` can no longer add keys to an HMAC-signed body), `url`
 * percent-encodes them (no path/query injection toward the webhook target).
 */
export function interpolate(
  template: string,
  vars: Record<string, unknown>,
  encoding: InterpolationEncoding = "raw",
): string {
  return template.replace(/\{\{\s*([\w.]+)\s*\}\}/g, (full, key: string) => {
    if (Object.prototype.hasOwnProperty.call(vars, key)) {
      const value = (vars as Record<string, unknown>)[key];
      if (value == null) return "";
      return encodeValue(typeof value === "string" ? value : JSON.stringify(value), encoding);
    }
    return full;
  });
}

/** Webhook URL for logs: origin only — Discord/Slack-style URLs carry their token in the path (N15). */
export const redactWebhookUrl = urlForLog;

type StoredWebhookConfig = WebhookConfig & { secretRef: number };

/**
 * Parse stored configs without decrypting anything. `secretRef` is the entry's
 * index in the stored array (the settings UI sends it back to keep a secret).
 */
function parseStoredConfigs(raw: string | null | undefined): StoredWebhookConfig[] {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    const out: StoredWebhookConfig[] = [];
    parsed.forEach((item, index) => {
      if (!item || typeof item !== "object" || typeof item.url !== "string") return;
      out.push({
        url: String(item.url),
        method: item.method && ["GET", "POST", "PUT", "PATCH", "DELETE"].includes(item.method)
          ? item.method
          : "POST",
        headers: item.headers && typeof item.headers === "object" ? item.headers : undefined,
        bodyTemplate: typeof item.bodyTemplate === "string" ? item.bodyTemplate : undefined,
        secret: typeof item.secret === "string" && item.secret ? item.secret : undefined,
        secretRef: index,
      });
    });
    return out;
  } catch {
    return [];
  }
}

/**
 * Header values and the signing secret may be stored as plaintext or as v2
 * `ff2.` ciphertext (security audit #2, M8; writers still store plaintext in
 * this release). Throws `SecretKeyError` if the configured keys cannot open them.
 */
function openHeaders(headers: Record<string, unknown> | undefined): Record<string, string> | undefined {
  if (!headers) return undefined;
  return Object.fromEntries(
    Object.entries(headers)
      .filter(([, v]) => typeof v === "string")
      .map(([k, v]) => [k, v ? openSecret(WEBHOOK_HEADER_PURPOSE, v as string, "plaintext").value : ""]),
  );
}

function parseConfigs(raw: string | null | undefined): Array<WebhookConfig | null> {
  return parseStoredConfigs(raw).map(({ secretRef: _ref, ...config }) => {
    try {
      return {
        ...config,
        headers: openHeaders(config.headers),
        secret: config.secret ? openSecret(WEBHOOK_SECRET_PURPOSE, config.secret, "plaintext").value : undefined,
      };
    } catch (error) {
      // Never fire a webhook without its (unreadable) signature or auth headers.
      warnSecretOnce(error, "autoReadRule.webhookConfigs");
      return null;
    }
  });
}

export function getWebhookConfig(
  rule: { webhookConfigs?: string | null },
  index: number,
): WebhookConfig | null {
  const configs = parseConfigs(rule.webhookConfigs);
  return configs[index] ?? null;
}

type IncomingWebhookConfig = {
  url?: unknown;
  method?: unknown;
  headers?: unknown;
  bodyTemplate?: unknown;
  secret?: unknown;
  /** Settings UI only: index of the stored config whose secret to keep (the client never sees it). */
  secretRef?: unknown;
};

export type SanitizedWebhookConfig = {
  url: string;
  method: string;
  headers?: Record<string, string>;
  bodyTemplate?: string;
  secret?: string;
};

/**
 * Validate and normalize an incoming array of webhook configs (from a Server
 * Action, REST body, or MCP tool arg). Every entry needs a valid http(s) URL;
 * `valid: false` means at least one entry was malformed and the whole set
 * should be rejected. Shared by every write surface so validation is identical.
 */
export function sanitizeWebhookConfigs(
  input: unknown,
  options: { existing?: string | null } = {},
): { configs: SanitizedWebhookConfig[]; valid: boolean } {
  if (!Array.isArray(input)) return { configs: [], valid: true };
  // Keep-if-unchanged: an entry without a new secret but with the `secretRef`
  // it was loaded with keeps the stored secret verbatim (only when the caller
  // passes the rule's current stored JSON).
  const stored = options.existing !== undefined ? parseStoredConfigs(options.existing) : null;
  const out: SanitizedWebhookConfig[] = [];
  for (const raw of input as IncomingWebhookConfig[]) {
    if (!raw || typeof raw !== "object") continue;
    const url = typeof raw.url === "string" ? raw.url.trim() : "";
    if (!url) return { configs: [], valid: false };
    try {
      const parsed = new URL(url);
      if (!["http:", "https:"].includes(parsed.protocol)) return { configs: [], valid: false };
    } catch {
      return { configs: [], valid: false };
    }
    const method = typeof raw.method === "string" && ["GET", "POST", "PUT", "PATCH", "DELETE"].includes(raw.method.toUpperCase())
      ? raw.method.toUpperCase()
      : "POST";
    const headers = raw.headers && typeof raw.headers === "object" && !Array.isArray(raw.headers)
      ? Object.fromEntries(
        Object.entries(raw.headers as Record<string, unknown>)
          .filter(([k, v]) => typeof k === "string" && typeof v === "string")
          .map(([k, v]) => [k.slice(0, 200), String(v).slice(0, 1000)]),
      )
      : undefined;
    const bodyTemplate = typeof raw.bodyTemplate === "string" ? raw.bodyTemplate : undefined;
    let secret = typeof raw.secret === "string" && raw.secret ? raw.secret : undefined;
    if (!secret && stored && typeof raw.secretRef === "number" && Number.isInteger(raw.secretRef)) {
      secret = stored.find((c) => c.secretRef === raw.secretRef)?.secret;
    }
    out.push({ url, method, headers, bodyTemplate, secret });
  }
  return { configs: out, valid: true };
}

/** True if every `webhook_call:<index>` action points at an existing config. */
export function actionsReferenceConfigs(actions: string[], configCount: number): boolean {
  for (const a of actions) {
    if (!a.startsWith("webhook_call:")) continue;
    const idx = Number.parseInt(a.slice("webhook_call:".length), 10);
    if (!Number.isFinite(idx) || idx < 0 || idx >= configCount) return false;
  }
  return true;
}

/**
 * Parse a stored `webhookConfigs` JSON string for API/MCP output, replacing the
 * secret with a boolean `hasSecret` flag. The HMAC signing secret must never
 * leave the server, so read surfaces expose everything about a webhook except
 * its secret value.
 */
export type RedactedWebhookConfig = {
  url: string;
  method: string;
  headers?: Record<string, string>;
  bodyTemplate?: string;
  hasSecret: boolean;
  /** Index in the stored list; send it back with an empty secret to keep the stored one. */
  secretRef: number;
};

export function redactWebhookConfigs(raw: string | null | undefined): RedactedWebhookConfig[] {
  return parseStoredConfigs(raw).map((c) => {
    let headers: Record<string, string> | undefined;
    try {
      headers = openHeaders(c.headers);
    } catch (error) {
      warnSecretOnce(error, "autoReadRule.webhookConfigs");
      headers = undefined;
    }
    return {
      url: c.url,
      method: c.method ?? "POST",
      headers,
      bodyTemplate: c.bodyTemplate,
      hasSecret: Boolean(c.secret),
      secretRef: c.secretRef,
    };
  });
}

/** An auto-read rule for the client: `webhookConfigs` carries redacted JSON (no secrets). */
export function redactRuleForClient<T extends { webhookConfigs?: string | null }>(rule: T): T {
  if (!rule.webhookConfigs) return rule;
  return { ...rule, webhookConfigs: JSON.stringify(redactWebhookConfigs(rule.webhookConfigs)) };
}

/** Default payload, built as an object and serialized once — never by string concatenation (N5). */
export function buildDefaultWebhookBody(vars: Record<string, unknown>): string {
  const str = (key: string) => {
    const value = vars[key];
    return value == null ? "" : typeof value === "string" ? value : String(value);
  };
  return JSON.stringify({
    event: str("event"),
    rule: str("rule_name"),
    timestamp: str("timestamp"),
    article: {
      id: str("article_id"),
      title: str("article_title"),
      link: str("article_link"),
      feed: str("feed_name"),
    },
  });
}

function bodyEncoding(headers: Record<string, string>): InterpolationEncoding {
  const contentType = Object.entries(headers).find(([name]) => name.toLowerCase() === "content-type")?.[1] ?? "";
  if (/json/i.test(contentType)) return "json";
  if (/x-www-form-urlencoded/i.test(contentType)) return "url";
  return "raw";
}

/**
 * Fire a single inline webhook synchronously. Returns success/failure but
 * never throws — the caller decides whether to retry. Fire-and-forget so a
 * misconfigured URL never blocks the rest of the rule pipeline for too long.
 */
export async function executeWebhookCall(
  config: WebhookConfig,
  vars: Record<string, unknown>,
): Promise<WebhookExecutionResult> {
  const url = interpolate(config.url, vars, "url");
  const method = (config.method ?? "POST").toUpperCase();
  const supportsBody = method !== "GET" && method !== "HEAD";

  const headers: Record<string, string> = {
    "User-Agent": "FeedFerret-Rules/1.0",
    ...(supportsBody ? { "Content-Type": "application/json" } : {}),
    ...(config.headers ?? {}),
  };
  const body = !supportsBody
    ? undefined
    : config.bodyTemplate !== undefined
      ? interpolate(config.bodyTemplate, vars, bodyEncoding(headers))
      : buildDefaultWebhookBody(vars);
  if (config.secret && body) {
    headers["X-FeedFerret-Signature"] = signPayload(config.secret, body);
  }

  try {
    const allowInternal = await isTrustedFeedFetchingAllowed();
    await assertSafeFetchUrl(url, { context: "Webhook", allowInternal });

    const res = await safeFetch(url, {
      redirect: "manual",
      method,
      headers,
      body,
      signal: AbortSignal.timeout(10_000),
    }, { allowInternal: await isTrustedFeedFetchingAllowed() });
    return {
      ok: res.ok,
      status: res.status,
      error: res.ok ? null : `HTTP ${res.status}`,
    };
  } catch (err) {
    return {
      ok: false,
      status: err instanceof FetchRedirectError ? err.status : null,
      error: String(err).slice(0, 500),
    };
  }
}
