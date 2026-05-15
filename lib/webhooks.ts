import { createHmac, randomBytes } from "crypto";

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
