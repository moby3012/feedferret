// URL hygiene for anything that goes into an AI prompt (page digest, feed
// config, article extraction). Page markup routinely carries credentials in
// links — signed CDN URLs, magic-login links, session ids, API keys, basic-auth
// userinfo — and none of that may leave the server towards an AI provider.

import { redact } from "./redact";

// Parameter names whose values are secrets or per-user identifiers.
const SENSITIVE_PARAM =
  /key|token|secret|passw(?:or)?d|pwd|auth|sig(?:nature)?|session|sess(?:id)?|^sid$|jwt|bearer|credential|otp|nonce|^code$|^state$|ticket|hash|hmac|e?mail|login|^user(?:name)?$|^uid$|account/i;
// Values that look like opaque credentials, whatever the parameter is called.
const OPAQUE_VALUE = /^[A-Za-z0-9_\-+/=.%]{32,}$/;

/**
 * Returns the URL with userinfo removed, the fragment dropped and sensitive
 * query values (by name or by shape) replaced with `***`. Harmless parameters
 * (`page=2`, `feed=rss2`, `zeitlinie=retail`) stay, so the model still sees
 * the structure of the site. Never throws; unparseable input is passed
 * through the generic text redactor.
 */
export function redactUrlForPrompt(raw: string, base?: URL | string): string {
  let u: URL;
  try {
    u = new URL(raw, base);
  } catch {
    return redact(raw);
  }
  u.username = "";
  u.password = "";
  u.hash = "";
  const params = [...u.searchParams.entries()];
  if (params.length) {
    const kept = params.map(([k, v]) => [k, SENSITIVE_PARAM.test(k) || OPAQUE_VALUE.test(v) ? "***" : v] as const);
    u.search = kept.map(([k, v]) => `${encodeURIComponent(k)}=${v === "***" ? v : encodeURIComponent(v)}`).join("&");
  }
  return u.toString();
}

/** Redacts every absolute or attribute URL inside a markup/text snippet bound for a prompt. */
export function redactUrlsInPromptText(text: string): string {
  return redact(text).replace(/\b(https?:\/\/[^\s"'<>]+|(?:href|src)=["'][^"']+["'])/gi, (m) => {
    const attr = /^(href|src)=(["'])([^"']+)\2$/i.exec(m);
    if (attr) {
      const v = attr[3];
      // Relative references: only the query matters.
      const redacted = /^[a-z][a-z0-9+.-]*:/i.test(v)
        ? redactUrlForPrompt(v)
        : redactUrlForPrompt(v, "https://relative.invalid").replace(/^https:\/\/relative\.invalid/, "");
      return `${attr[1]}=${attr[2]}${redacted}${attr[2]}`;
    }
    return redactUrlForPrompt(m);
  });
}
