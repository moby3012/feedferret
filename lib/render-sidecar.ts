// Browser-render sidecar connector (M7-T2).
//
// Some pages are genuinely client-only: the article/listing never appears in
// the static HTML, so neither our in-process fetch nor the ftr/JSON-LD tiers
// can reach it. Rather than ship a headless browser inside the default image
// (~400–500 MB of Chromium for every deployment, running an untrusted-page
// browser in the reader's own container), FeedFerret can call out to an
// OPTIONAL, admin-configured sidecar service that renders the page and returns
// HTML. If no sidecar is configured the feature is simply absent — the
// RSSHub/changedetection.io connector pattern.
//
// Contract (deliberately minimal so a lean Playwright service or crawl4ai can
// satisfy it): POST the target URL to the configured base URL and get rendered
// HTML back, either as `text/html` or as JSON containing one of
// `html` / `content` / `cleaned_html` / `markdown`. An optional bearer token
// is sent as `Authorization: Bearer …`.
//
// Security: the sidecar base URL is admin-configured and therefore trusted (it
// is expected to live on an internal network), but the *target* URL we ask it
// to render is still validated through the same SSRF policy as a direct fetch,
// so the sidecar can never be used as an SSRF bypass for a malicious feed URL.

import { db } from "@/lib/db";
import { decryptIfValue } from "@/lib/crypto";
import { assertSafeFetchUrl, isTrustedFeedFetchingAllowed } from "@/lib/ssrf";

export type RenderSidecarConfig = { url: string; token: string | null };

function truthy(value?: string) {
  return ["1", "true", "yes", "on"].includes(String(value || "").toLowerCase());
}

// Kill-switch, mirroring the impit/ftr toggles.
const SIDECAR_DISABLED = truthy(process.env.FEEDFERRET_DISABLE_RENDER_SIDECAR);

/**
 * Resolves the effective sidecar config, or null when unconfigured/disabled.
 * ENV (`FEEDFERRET_RENDER_SIDECAR_URL` / `_TOKEN`) wins for immutable/container
 * deployments; otherwise the admin-managed GlobalSettings row is used.
 *
 * Never throws: this runs on every full-text/page-feed fetch, including on
 * deployments that haven't yet applied the renderSidecar* schema migration —
 * a DB error here must degrade to "no sidecar configured", not break the
 * (unrelated) extraction that's asking for it.
 */
export async function getRenderSidecarConfig(): Promise<RenderSidecarConfig | null> {
  if (SIDECAR_DISABLED) return null;

  const envUrl = process.env.FEEDFERRET_RENDER_SIDECAR_URL?.trim();
  if (envUrl) {
    return { url: envUrl, token: process.env.FEEDFERRET_RENDER_SIDECAR_TOKEN?.trim() || null };
  }

  try {
    const settings = await db.globalSettings.findUnique({
      where: { id: "global" },
      select: { renderSidecarEnabled: true, renderSidecarUrl: true, renderSidecarToken: true },
    });
    if (!settings?.renderSidecarEnabled || !settings.renderSidecarUrl?.trim()) return null;

    return {
      url: settings.renderSidecarUrl.trim(),
      token: decryptIfValue(settings.renderSidecarToken) || null,
    };
  } catch {
    return null;
  }
}

/** Cheap "is the heavy-render path available?" check for UI/flow gating. */
export async function isRenderSidecarConfigured(): Promise<boolean> {
  return (await getRenderSidecarConfig()) !== null;
}

/**
 * Pulls rendered HTML out of a sidecar response body. Pure/testable: accepts a
 * raw `text/html` document as-is, or a JSON envelope with an `html` /
 * `content` / `cleaned_html` / `markdown` field (checked in that order).
 * Returns null when nothing usable is present.
 */
export function extractHtmlFromSidecarResponse(contentType: string, body: string): string | null {
  const type = (contentType || "").toLowerCase();
  if (type.includes("application/json")) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(body);
    } catch {
      return null;
    }
    // crawl4ai nests results under `results[0]` / `result`; accept either the
    // top-level object or the first result.
    const candidates: unknown[] = [parsed];
    if (parsed && typeof parsed === "object") {
      const obj = parsed as Record<string, unknown>;
      if (Array.isArray(obj.results)) candidates.push(obj.results[0]);
      if (obj.result) candidates.push(obj.result);
    }
    for (const candidate of candidates) {
      if (!candidate || typeof candidate !== "object") continue;
      const obj = candidate as Record<string, unknown>;
      for (const key of ["html", "content", "cleaned_html", "markdown"]) {
        const value = obj[key];
        if (typeof value === "string" && value.trim()) return value;
      }
    }
    return null;
  }
  // Anything else (text/html, text/plain) is treated as the document itself.
  return body.trim() ? body : null;
}

export type RenderViaSidecarOptions = {
  context?: string;
  maxBytes?: number;
  timeoutMs?: number;
};

/**
 * Asks the configured sidecar to render `targetUrl` and returns the rendered
 * HTML, or null when no sidecar is configured or the render fails/empties.
 * Never throws — callers use it as a best-effort fallback after the in-process
 * path comes up empty. The target URL is SSRF-validated before it is sent.
 */
export async function renderViaSidecar(
  targetUrl: string,
  options: RenderViaSidecarOptions = {},
): Promise<string | null> {
  const config = await getRenderSidecarConfig();
  if (!config) return null;
  return renderWithConfig(config, targetUrl, options);
}

/**
 * Same as `renderViaSidecar` but against an explicitly-provided config (used by
 * the admin "Test" button, which validates values before they are saved).
 * Returns null on any failure; never throws.
 */
export async function renderWithConfig(
  config: RenderSidecarConfig,
  targetUrl: string,
  options: RenderViaSidecarOptions = {},
): Promise<string | null> {
  const maxBytes = options.maxBytes ?? 4 * 1024 * 1024;
  const timeoutMs = options.timeoutMs ?? 45_000;
  const context = options.context ?? "Render sidecar";

  // Validate the *target* with the same policy as a direct fetch — the sidecar
  // must not become an SSRF bypass. (The sidecar base URL itself is trusted
  // admin config and validated with allowInternal.)
  try {
    await assertSafeFetchUrl(targetUrl, {
      allowInternal: await isTrustedFeedFetchingAllowed(),
      context,
    });
    await assertSafeFetchUrl(config.url, { allowInternal: true, context });
  } catch {
    return null;
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const headers: Record<string, string> = {
      "content-type": "application/json",
      accept: "application/json, text/html",
    };
    if (config.token) headers.authorization = `Bearer ${config.token}`;

    const response = await fetch(config.url, {
      method: "POST",
      headers,
      body: JSON.stringify({ url: targetUrl }),
      redirect: "follow",
      signal: controller.signal,
    });
    if (!response.ok) return null;

    // Size-cap the body defensively (rendered pages can be large).
    const buffer = await response.arrayBuffer();
    if (buffer.byteLength > maxBytes) return null;
    const body = new TextDecoder().decode(buffer);

    return extractHtmlFromSidecarResponse(response.headers.get("content-type") || "", body);
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}
