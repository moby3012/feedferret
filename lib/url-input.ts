import { canonicalApiSourceUrl } from "./feed-adapters/api-source-url";
// One normaliser for every "the user typed/pasted a page or feed address"
// entry point (Add-Feed dialog tabs, page→feed, AI setup, REST v1, MCP).
//
// Users paste whatever their address bar or a chat message gave them:
// `chromie.de`, `www.example.org/blog`, `<https://x.dev/feed>`,
// `"example.com/rss",` or `feed://example.com/atom.xml`. All of these mean a
// web address; only the old `new URL(input)` check rejected them. The
// normaliser is generic (no host lists) and never touches the network: a
// scheme-less input becomes `https://…` and `schemeAssumed` tells callers
// that may retry over plain `http://` when the https attempt cannot connect.

import { MAX_FEED_URL_LENGTH } from "./validation";

export type UrlInputErrorCode = "url-empty" | "url-too-long" | "url-invalid" | "url-unsupported-scheme";

export type NormalizedUrlInput =
  | { ok: true; url: string; schemeAssumed: boolean }
  | { ok: false; code: UrlInputErrorCode };

/** English fallback texts (REST/MCP clients); the web UI localises `code`. */
export const URL_INPUT_ERROR_TEXT: Record<UrlInputErrorCode, string> = {
  "url-empty": "Enter a web or feed address",
  "url-too-long": "That address is too long",
  "url-invalid": "That doesn't look like a web address (e.g. example.com)",
  "url-unsupported-scheme": "Only web addresses (http/https) are supported",
};

// Wrapping pairs that come with copy/paste from chats, Markdown or e-mail.
const WRAPPERS: Array<[string, string]> = [
  ["<", ">"],
  ['"', '"'],
  ["'", "'"],
  ["“", "”"],
  ["„", "“"],
  ["«", "»"],
  ["‹", "›"],
  ["(", ")"],
  ["[", "]"],
  ["`", "`"],
];

// Host with at least one dot (or an IPv4 address), optional port, optional path.
const HOST_LIKE = /^(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+(?:[a-z0-9-]*[a-z0-9])(?::\d{1,5})?(?:[/?#]\S*)?$/i;
const IPV6_HOST = /^\[[0-9a-f:.]+\](?::\d{1,5})?(?:[/?#]\S*)?$/i;
const LOCALHOST = /^localhost(?::\d{1,5})?(?:[/?#]\S*)?$/i;
// Zero-width space/joiners, BOM and NBSP sneak in from rich-text copies.
const INVISIBLE = new RegExp(`[${String.fromCharCode(0x200b)}-${String.fromCharCode(0x200d)}${String.fromCharCode(0xfeff)}]`, "g");
const NBSP = new RegExp(String.fromCharCode(0xa0), "g");
const SCHEME = /^([a-z][a-z0-9+.-]*):/i;

function stripWrappers(value: string): string {
  let s = value;
  for (let changed = true; changed && s.length > 1; ) {
    changed = false;
    for (const [open, close] of WRAPPERS) {
      if (s.startsWith(open) && s.endsWith(close) && s.length > open.length + close.length - 1) {
        s = s.slice(open.length, s.length - close.length).trim();
        changed = true;
      }
    }
  }
  return s;
}

/** Trailing sentence punctuation / unbalanced closers from prose ("see example.com/feed."). */
function stripTrailingJunk(value: string): string {
  let s = value;
  for (;;) {
    const last = s.at(-1);
    if (!last) return s;
    if (/[.,;:!?'"”’»›…]/.test(last)) {
      s = s.slice(0, -1);
      continue;
    }
    const pairs: Record<string, string> = { ")": "(", "]": "[", "}": "{", ">": "<" };
    if (last in pairs) {
      const opens = s.split(pairs[last]).length - 1;
      const closes = s.split(last).length - 1;
      if (closes > opens) {
        s = s.slice(0, -1);
        continue;
      }
    }
    return s;
  }
}

/**
 * Strips copy/paste wrapping (quotes, brackets, Markdown link syntax) and
 * trailing sentence punctuation from a single-token input. Inputs with inner
 * whitespace (topic phrases) come back trimmed but otherwise untouched.
 */
export function cleanUrlInput(raw: string): string {
  const trimmed = (raw ?? "").replace(INVISIBLE, "").replace(NBSP, " ").trim();
  // Markdown link `[title](https://…)` → the target.
  let s = /^\[[^\]]*\]\((\S+)\)$/.exec(trimmed)?.[1] ?? trimmed;
  for (let prev = ""; prev !== s; ) {
    prev = s;
    s = stripTrailingJunk(stripWrappers(s)).trim();
  }
  // A leftover opener (`"example.com/rss",` lost its closer to the junk strip):
  // an address never starts with one.
  s = s.replace(/^[<"'`(\[«‹“„]+(?=[\w/])/u, "");
  return !s || /\s/.test(s) ? trimmed : s;
}

function parseHttpUrl(candidate: string): URL | null {
  try {
    const url = new URL(candidate);
    if (url.protocol !== "http:" && url.protocol !== "https:") return null;
    if (!url.hostname) return null;
    return url;
  } catch {
    return null;
  }
}

/**
 * Turns user input into an absolute http(s) URL string. Accepts bare domains,
 * `www.`, scheme-less paths, protocol-relative `//host`, `feed:`/`feed://`
 * links, surrounding quotes/brackets and trailing punctuation. Never throws.
 */
export function normalizeUrlInput(raw: unknown): NormalizedUrlInput {
  if (typeof raw !== "string") return { ok: false, code: "url-empty" };
  // Zero-width characters and NBSPs sneak in from rich-text copies.
  if (!raw.replace(INVISIBLE, "").replace(NBSP, " ").trim()) return { ok: false, code: "url-empty" };
  if (raw.trim().length > MAX_FEED_URL_LENGTH) return { ok: false, code: "url-too-long" };
  // Wrappers, Markdown link `[title](https://…)`, trailing punctuation.
  let s = cleanUrlInput(raw);
  if (!s) return { ok: false, code: "url-empty" };
  // An address never contains inner whitespace; prose around it is not ours to guess.
  if (/\s/.test(s)) return { ok: false, code: "url-invalid" };

  // feed:https://x / feed://x (RSS subscribe links) → the web URL.
  s = s.replace(/^feed:(?=https?:)/i, "").replace(/^feed:\/\//i, "https://");
  if (s.startsWith("//")) s = `https:${s}`;

  const apiSource = canonicalApiSourceUrl(s);
  if (apiSource) return { ok: true, url: apiSource, schemeAssumed: false };
  const scheme = SCHEME.exec(s);
  // "example.com:8080/x" / "localhost:3000" parse as a scheme — it is a port.
  const isPortNotScheme = scheme && /^\d{1,5}(?:[/?#]|$)/.test(s.slice(scheme[0].length));
  if (scheme && !isPortNotScheme) {
    const proto = scheme[1].toLowerCase();
    if (proto !== "http" && proto !== "https") return { ok: false, code: "url-unsupported-scheme" };
    const url = parseHttpUrl(s.replace(/^(https?):\/*/i, "$1://"));
    if (!url) return { ok: false, code: "url-invalid" };
    return { ok: true, url: url.toString(), schemeAssumed: false };
  }

  if (!HOST_LIKE.test(s) && !IPV6_HOST.test(s) && !LOCALHOST.test(s)) return { ok: false, code: "url-invalid" };
  const url = parseHttpUrl(`https://${s}`);
  if (!url) return { ok: false, code: "url-invalid" };
  return { ok: true, url: url.toString(), schemeAssumed: true };
}

/** The plain-http twin of an assumed-https URL (for the one connect-failure retry). */
export function httpFallbackUrl(url: string): string | null {
  return url.startsWith("https://") ? `http://${url.slice("https://".length)}` : null;
}

export type FetchFailureKind = "connect" | "tls" | "other";

// Connection-level failures where nothing was spoken with the server at all
// (refused, no route, connect timeout). Deliberately NOT here: ECONNRESET
// (can happen mid-handshake), DNS errors (http would fail the same way) and
// anything unknown — those never trigger the http retry.
const CONNECT_CODES = new Set(["ECONNREFUSED", "EHOSTUNREACH", "ENETUNREACH", "ETIMEDOUT", "UND_ERR_CONNECT_TIMEOUT"]);
const TLS_CODE = /^(?:CERT_|ERR_TLS_|ERR_SSL_|ERR_OSSL_|SSL_|UNABLE_TO_(?:GET|VERIFY|DECRYPT)|DEPTH_ZERO_SELF_SIGNED_CERT$|SELF_SIGNED_CERT_IN_CHAIN$|HOSTNAME_MISMATCH$|INVALID_CA$|INVALID_PURPOSE$|EPROTO$)/;
const TLS_MESSAGE = /certificate|\bssl\b|\btls\b|handshake|self[- ]signed|wrong version number|secure TLS connection/i;

/** Codes and messages of an error and its whole `cause` / AggregateError chain. */
function errorChain(error: unknown): Array<{ code: string; message: string }> {
  const out: Array<{ code: string; message: string }> = [];
  const seen = new Set<unknown>();
  const visit = (e: unknown, depth: number) => {
    if (e == null || depth > 10 || seen.has(e)) return;
    seen.add(e);
    if (typeof e !== "object") {
      out.push({ code: "", message: String(e) });
      return;
    }
    const rec = e as { code?: unknown; message?: unknown; cause?: unknown; errors?: unknown };
    out.push({ code: typeof rec.code === "string" ? rec.code : "", message: typeof rec.message === "string" ? rec.message : "" });
    visit(rec.cause, depth + 1);
    if (Array.isArray(rec.errors)) rec.errors.forEach((x) => visit(x, depth + 1));
  };
  visit(error, 0);
  return out;
}

/**
 * Classifies a failed fetch by walking the whole cause chain (undici wraps
 * everything as `TypeError: fetch failed`):
 * - "tls": any certificate / TLS / handshake indication anywhere in the chain
 *   (CERT_*, ERR_TLS_*, ERR_SSL_*, self-signed, wrong version number, …).
 *   The server (or someone in between) answered — this must never be
 *   "fixed" by retrying over plain http (that would be a MITM downgrade).
 * - "connect": a genuine connection-level failure from the allowlist.
 * - "other": everything else, including unknown errors.
 */
export function classifyFetchFailure(error: unknown): FetchFailureKind {
  const chain = errorChain(error);
  if (chain.some((e) => TLS_CODE.test(e.code) || TLS_MESSAGE.test(e.message))) return "tls";
  if (chain.some((e) => CONNECT_CODES.has(e.code))) return "connect";
  return "other";
}

/**
 * The only case where retrying an assumed-https address over http is
 * allowed: the https connection could not be opened at all (allowlisted
 * connection-level codes). TLS/certificate failures, HTTP status errors,
 * SSRF refusals and unknown errors never qualify.
 */
export function isConnectError(error: unknown): boolean {
  return classifyFetchFailure(error) === "connect";
}

/** A certificate / TLS handshake failure (shown to the user as such). */
export function isTlsError(error: unknown): boolean {
  return classifyFetchFailure(error) === "tls";
}

/**
 * `s` without any trailing run of `ch` — a backward character scan. Never
 * `s.replace(/x+$/, "")` on untrusted strings: the regex retries the run from
 * every start position (quadratic on "////…/a").
 */
export function trimTrailing(s: string, ch: string): string {
  let end = s.length;
  while (end > 0 && s[end - 1] === ch) end--;
  return end === s.length ? s : s.slice(0, end);
}
