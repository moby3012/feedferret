import { createHmac, randomBytes } from "crypto";
import { assertSafeFetchUrl, isTrustedFeedFetchingAllowed } from "@/lib/ssrf";

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

/**
 * Substitute `{{var}}` placeholders in a template.
 * Unknown keys are left as the literal string `{{key}}` so the user can
 * spot typos in the request log instead of getting an empty value.
 */
export function interpolate(template: string, vars: Record<string, unknown>): string {
  return template.replace(/\{\{\s*([\w.]+)\s*\}\}/g, (full, key: string) => {
    if (Object.prototype.hasOwnProperty.call(vars, key)) {
      const value = (vars as Record<string, unknown>)[key];
      if (value == null) return "";
      return typeof value === "string" ? value : JSON.stringify(value);
    }
    return full;
  });
}

function parseConfigs(raw: string | null | undefined): WebhookConfig[] {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed
      .filter((item) => item && typeof item === "object" && typeof item.url === "string")
      .map((item) => ({
        url: String(item.url),
        method: item.method && ["GET", "POST", "PUT", "PATCH", "DELETE"].includes(item.method)
          ? item.method
          : "POST",
        headers: item.headers && typeof item.headers === "object" ? item.headers : undefined,
        bodyTemplate: typeof item.bodyTemplate === "string" ? item.bodyTemplate : undefined,
        secret: typeof item.secret === "string" && item.secret ? item.secret : undefined,
      }));
  } catch {
    return [];
  }
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
export function sanitizeWebhookConfigs(input: unknown): { configs: SanitizedWebhookConfig[]; valid: boolean } {
  if (!Array.isArray(input)) return { configs: [], valid: true };
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
    const secret = typeof raw.secret === "string" && raw.secret ? raw.secret : undefined;
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
export function redactWebhookConfigs(
  raw: string | null | undefined,
): Array<{ url: string; method: string; headers?: Record<string, string>; bodyTemplate?: string; hasSecret: boolean }> {
  return parseConfigs(raw).map((c) => ({
    url: c.url,
    method: c.method ?? "POST",
    headers: c.headers,
    bodyTemplate: c.bodyTemplate,
    hasSecret: Boolean(c.secret),
  }));
}

const DEFAULT_BODY = JSON.stringify({
  event: "{{event}}",
  rule: "{{rule_name}}",
  timestamp: "{{timestamp}}",
  article: {
    id: "{{article_id}}",
    title: "{{article_title}}",
    link: "{{article_link}}",
    feed: "{{feed_name}}",
  },
});

/**
 * Fire a single inline webhook synchronously. Returns success/failure but
 * never throws — the caller decides whether to retry. Fire-and-forget so a
 * misconfigured URL never blocks the rest of the rule pipeline for too long.
 */
export async function executeWebhookCall(
  config: WebhookConfig,
  vars: Record<string, unknown>,
): Promise<WebhookExecutionResult> {
  const url = interpolate(config.url, vars);
  const method = (config.method ?? "POST").toUpperCase();
  const supportsBody = method !== "GET" && method !== "HEAD";
  const bodyTemplate = config.bodyTemplate ?? (supportsBody ? DEFAULT_BODY : "");
  const body = supportsBody ? interpolate(bodyTemplate, vars) : undefined;

  const headers: Record<string, string> = {
    "User-Agent": "FeedFerret-Rules/1.0",
    ...(supportsBody ? { "Content-Type": "application/json" } : {}),
    ...(config.headers ?? {}),
  };
  if (config.secret && body) {
    headers["X-FeedFerret-Signature"] = signPayload(config.secret, body);
  }

  try {
    const allowInternal = await isTrustedFeedFetchingAllowed();
    await assertSafeFetchUrl(url, { context: "Webhook", allowInternal });

    const res = await fetch(url, {
      method,
      headers,
      body,
      signal: AbortSignal.timeout(10_000),
    });
    return {
      ok: res.ok,
      status: res.status,
      error: res.ok ? null : `HTTP ${res.status}`,
    };
  } catch (err) {
    return {
      ok: false,
      status: null,
      error: String(err).slice(0, 500),
    };
  }
}
