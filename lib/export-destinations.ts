// F5: Export / "Send to" destinations from the article reader.
//
// Each destination follows this codebase's "never throw internally, return
// {success, error?}" convention (see lib/hosted-fetch.ts, lib/render-sidecar.ts).
//
// - Obsidian has no API at all — it's a local vault app, not a service. The
//   only integration that makes sense is generating an `obsidian://new` deep
//   link (Obsidian's own documented URI scheme — see
//   https://help.obsidian.md/Advanced+topics/Using+obsidian+URI) with the
//   article as Markdown, which hands off straight to the user's own already-
//   installed Obsidian app. No network request from this server, no
//   credentials, nothing ever leaves this server except the link itself.
// - Wallabag is a self-hosted read-later app (matches this project's
//   self-hosting ethos): OAuth2 "password" grant against `/oauth/v2/token`,
//   then `POST /api/entries` with the article.
//
// Readwise and Pocket were intentionally left out of this slice — their
// "save article" API contracts couldn't be confidently verified from training
// knowledge alone, and this codebase's bar is "no guessed integrations
// shipped as if confirmed working." See the PR description / roadmap for the
// follow-up note.

import { assertSafeFetchUrl, isTrustedFeedFetchingAllowed } from "@/lib/ssrf";

export type ObsidianExportInput = {
  vault: string;
  title: string;
  content: string; // Markdown body
  sourceUrl?: string | null;
};

export type ObsidianExportOutcome =
  | { success: true; url: string }
  | { success: false; error: string };

// Obsidian's `file` param is a note title/path — strip characters that are
// invalid in filenames on at least one major OS (Windows is the strictest).
function sanitizeObsidianFileName(title: string): string {
  const cleaned = title
    .replace(/[\\/:*?"<>|#^[\]]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  return (cleaned || "Untitled").slice(0, 180);
}

/**
 * Builds an `obsidian://new` deep link for the given article. Pure/sync — no
 * I/O, safe to call from a server action on every "Send to Obsidian" click.
 */
export function buildObsidianUrl(input: ObsidianExportInput): ObsidianExportOutcome {
  try {
    const vault = input.vault.trim();
    if (!vault) return { success: false, error: "No Obsidian vault configured" };
    const title = input.title?.trim() || "Untitled";
    const fileName = sanitizeObsidianFileName(title);
    const bodyLines = [`# ${title}`];
    if (input.sourceUrl) bodyLines.push("", `Source: ${input.sourceUrl}`);
    bodyLines.push("", input.content || "");
    const params = new URLSearchParams({
      vault,
      file: fileName,
      content: bodyLines.join("\n"),
    });
    return { success: true, url: `obsidian://new?${params.toString()}` };
  } catch (err) {
    return { success: false, error: err instanceof Error ? err.message : String(err) };
  }
}

export type WallabagConfig = {
  baseUrl: string;
  clientId: string;
  clientSecret: string;
  username: string;
  password: string;
};

type WallabagTokenOutcome = { ok: true; token: string } | { ok: false; error: string };

async function getWallabagAccessToken(config: WallabagConfig, timeoutMs = 15_000): Promise<WallabagTokenOutcome> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const allowInternal = await isTrustedFeedFetchingAllowed();
    await assertSafeFetchUrl(config.baseUrl, { context: "Wallabag export", allowInternal });

    const base = config.baseUrl.replace(/\/$/, "");
    const body = new URLSearchParams({
      grant_type: "password",
      client_id: config.clientId,
      client_secret: config.clientSecret,
      username: config.username,
      password: config.password,
    });
    const res = await fetch(`${base}/oauth/v2/token`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: body.toString(),
      signal: controller.signal,
    });
    if (!res.ok) {
      const errText = await res.text().catch(() => "");
      return { ok: false, error: `Wallabag authentication failed (HTTP ${res.status}): ${errText.slice(0, 200)}` };
    }
    const json = (await res.json().catch(() => null)) as { access_token?: string } | null;
    if (!json?.access_token) return { ok: false, error: "Wallabag did not return an access token" };
    return { ok: true, token: json.access_token };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  } finally {
    clearTimeout(timer);
  }
}

export type WallabagArticleInput = {
  url: string;
  title?: string;
  content?: string;
  tags?: string[];
};

export type WallabagOutcome = { success: boolean; error?: string };

/** Posts a single article to the user's Wallabag instance as a new entry. */
export async function sendToWallabag(config: WallabagConfig, article: WallabagArticleInput): Promise<WallabagOutcome> {
  const auth = await getWallabagAccessToken(config);
  if (!auth.ok) return { success: false, error: auth.error };

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 20_000);
  try {
    const base = config.baseUrl.replace(/\/$/, "");
    const res = await fetch(`${base}/api/entries`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${auth.token}`,
      },
      body: JSON.stringify({
        url: article.url,
        title: article.title,
        content: article.content,
        tags: article.tags?.length ? article.tags.join(",") : undefined,
      }),
      signal: controller.signal,
    });
    if (!res.ok) {
      const errText = await res.text().catch(() => "");
      return { success: false, error: `Wallabag rejected the entry (HTTP ${res.status}): ${errText.slice(0, 200)}` };
    }
    return { success: true };
  } catch (err) {
    return { success: false, error: err instanceof Error ? err.message : String(err) };
  } finally {
    clearTimeout(timer);
  }
}

/** Lightweight reachability/credentials check for the settings "Test connection" button. */
export async function testWallabagConfig(config: WallabagConfig): Promise<WallabagOutcome> {
  const auth = await getWallabagAccessToken(config);
  if (!auth.ok) return { success: false, error: auth.error };
  return { success: true };
}
