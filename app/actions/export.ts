"use server";

// F5: Export / "Send to" destinations (Obsidian, Wallabag) from the article
// reader. Follows the same per-user BYOK settings pattern as AI settings
// (app/actions/settings.ts's getAiSettings/updateAiSettings) and the
// hosted-fetch connector: encrypted credential storage via lib/crypto.ts,
// getX/updateX/testX server actions, hidden in the UI until configured.

import { auth } from "@/auth";
import { db } from "@/lib/db";
import { revalidatePath } from "next/cache";
import { encryptIfValue, decryptIfValue } from "@/lib/crypto";
import { guardHtml } from "@/lib/html-guard";
import { runHtmlTask } from "@/lib/html-worker/pool";
import {
  buildObsidianUrl,
  sendToWallabag,
  testWallabagConfig,
  type WallabagConfig,
  sendToReadeck,
  testReadeckConfig,
  type ReadeckConfig,
  sendToLinkwarden,
  testLinkwardenConfig,
  type LinkwardenConfig,
} from "@/lib/export-destinations";

async function requireUser() {
  const session = await auth();
  if (!session?.user?.id) throw new Error("Unauthorized");
  return session;
}

export async function getExportSettings() {
  const session = await requireUser();
  const user = await db.user.findUnique({
    where: { id: session.user.id },
    select: {
      exportObsidianVault: true,
      exportWallabagUrl: true,
      exportWallabagClientId: true,
      exportWallabagClientSecret: true,
      exportWallabagUsername: true,
      exportWallabagPassword: true,
      exportReadeckUrl: true,
      exportReadeckApiKey: true,
      exportLinkwardenUrl: true,
      exportLinkwardenApiKey: true,
    },
  });

  const wallabagConfigured = !!(
    user?.exportWallabagUrl &&
    user?.exportWallabagClientId &&
    user?.exportWallabagClientSecret &&
    user?.exportWallabagUsername &&
    user?.exportWallabagPassword
  );

  const readeckConfigured = !!(
    user?.exportReadeckUrl &&
    user?.exportReadeckApiKey
  );

  const linkwardenConfigured = !!(
    user?.exportLinkwardenUrl &&
    user?.exportLinkwardenApiKey
  );

  return {
    obsidianVault: user?.exportObsidianVault ?? null,
    obsidianConfigured: !!user?.exportObsidianVault,
    wallabagUrl: user?.exportWallabagUrl ?? null,
    wallabagClientId: user?.exportWallabagClientId ?? null,
    wallabagUsername: user?.exportWallabagUsername ?? null,
    hasWallabagClientSecret: !!user?.exportWallabagClientSecret,
    hasWallabagPassword: !!user?.exportWallabagPassword,
    wallabagConfigured,
    readeckUrl: user?.exportReadeckUrl ?? null,
    hasReadeckApiKey: !!user?.exportReadeckApiKey,
    readeckConfigured,
    linkwardenUrl: user?.exportLinkwardenUrl ?? null,
    hasLinkwardenApiKey: !!user?.exportLinkwardenApiKey,
    linkwardenConfigured,
  };
}

export async function updateExportSettings(data: {
  obsidianVault?: string | null;
  wallabagUrl?: string | null;
  wallabagClientId?: string | null;
  wallabagClientSecret?: string | null;
  clearWallabagClientSecret?: boolean;
  wallabagUsername?: string | null;
  wallabagPassword?: string | null;
  clearWallabagPassword?: boolean;
  readeckUrl?: string | null;
  readeckApiKey?: string | null;
  clearReadeckApiKey?: boolean;
  linkwardenUrl?: string | null;
  linkwardenApiKey?: string | null;
  clearLinkwardenApiKey?: boolean;
}) {
  const session = await requireUser();
  const updateData: Record<string, unknown> = {};

  if ("obsidianVault" in data) updateData.exportObsidianVault = data.obsidianVault?.trim() || null;
  if ("wallabagUrl" in data) updateData.exportWallabagUrl = data.wallabagUrl?.trim() || null;
  if ("wallabagClientId" in data) updateData.exportWallabagClientId = data.wallabagClientId?.trim() || null;
  if ("wallabagUsername" in data) updateData.exportWallabagUsername = data.wallabagUsername?.trim() || null;

  if (data.clearWallabagClientSecret) {
    updateData.exportWallabagClientSecret = null;
  } else if (data.wallabagClientSecret) {
    updateData.exportWallabagClientSecret = encryptIfValue(data.wallabagClientSecret, "user.exportWallabagClientSecret");
  }

  if (data.clearWallabagPassword) {
    updateData.exportWallabagPassword = null;
  } else if (data.wallabagPassword) {
    updateData.exportWallabagPassword = encryptIfValue(data.wallabagPassword, "user.exportWallabagPassword");
  }

  if ("readeckUrl" in data) updateData.exportReadeckUrl = data.readeckUrl?.trim() || null;
  if (data.clearReadeckApiKey) {
    updateData.exportReadeckApiKey = null;
  } else if (data.readeckApiKey) {
    updateData.exportReadeckApiKey = encryptIfValue(data.readeckApiKey);
  }

  if ("linkwardenUrl" in data) updateData.exportLinkwardenUrl = data.linkwardenUrl?.trim() || null;
  if (data.clearLinkwardenApiKey) {
    updateData.exportLinkwardenApiKey = null;
  } else if (data.linkwardenApiKey) {
    updateData.exportLinkwardenApiKey = encryptIfValue(data.linkwardenApiKey);
  }

  await db.user.update({ where: { id: session.user.id }, data: updateData });
  revalidatePath("/settings");
}

export async function testWallabagExportConnection(overrides?: {
  wallabagUrl?: string;
  wallabagClientId?: string;
  wallabagClientSecret?: string;
  wallabagUsername?: string;
  wallabagPassword?: string;
}): Promise<{ success: boolean; error?: string }> {
  const session = await requireUser();
  const user = await db.user.findUnique({
    where: { id: session.user.id },
    select: {
      exportWallabagUrl: true,
      exportWallabagClientId: true,
      exportWallabagClientSecret: true,
      exportWallabagUsername: true,
      exportWallabagPassword: true,
    },
  });

  // Test the form's current (possibly unsaved) values, not just what's
  // persisted — mirrors testAiConnection/testContentFetchConnection.
  const baseUrl = overrides?.wallabagUrl || user?.exportWallabagUrl;
  const clientId = overrides?.wallabagClientId || user?.exportWallabagClientId;
  const clientSecret = overrides?.wallabagClientSecret || decryptIfValue(user?.exportWallabagClientSecret, "user.exportWallabagClientSecret");
  const username = overrides?.wallabagUsername || user?.exportWallabagUsername;
  const password = overrides?.wallabagPassword || decryptIfValue(user?.exportWallabagPassword, "user.exportWallabagPassword");

  if (!baseUrl || !clientId || !clientSecret || !username || !password) {
    return { success: false, error: "Fill in the instance URL, client ID/secret, and username/password first" };
  }

  return testWallabagConfig({ baseUrl, clientId, clientSecret, username, password });
}

async function loadArticleForExport(userId: string, articleId: string) {
  const article = await db.article.findFirst({
    where: { id: articleId, userId },
    select: { id: true, title: true, link: true, content: true, contentFormat: true },
  });
  if (!article) throw new Error("Article not found");
  const { redactArticleForClient } = await import("@/lib/connector-secrets");
  return redactArticleForClient(article);
}

/** HTML → Markdown (turndown parses the HTML) in the HTML worker pool; the stored HTML on any failure. */
async function articleAsMarkdown(article: { content: string; contentFormat: string | null }): Promise<string> {
  if (article.contentFormat === "markdown") return article.content || "";
  try {
    return await runHtmlTask("htmlToMarkdown", guardHtml(article.content || "").html);
  } catch {
    return article.content || "";
  }
}

/**
 * Builds an obsidian://new deep link for the given article. Obsidian has no
 * API — this is the whole "integration": the client hands the resulting URL
 * to the OS, which opens the user's own already-installed Obsidian app.
 */
export async function buildObsidianExportLink(
  articleId: string,
): Promise<{ success: boolean; url?: string; error?: string }> {
  const session = await requireUser();
  const user = await db.user.findUnique({
    where: { id: session.user.id },
    select: { exportObsidianVault: true },
  });
  if (!user?.exportObsidianVault) {
    return { success: false, error: "No Obsidian vault configured" };
  }

  const article = await loadArticleForExport(session.user.id, articleId);
  const result = buildObsidianUrl({
    vault: user.exportObsidianVault,
    title: article.title,
    content: await articleAsMarkdown(article),
    sourceUrl: article.link,
  });
  return result.success ? { success: true, url: result.url } : { success: false, error: result.error };
}

export async function exportArticleToWallabag(
  articleId: string,
): Promise<{ success: boolean; error?: string }> {
  const session = await requireUser();
  const user = await db.user.findUnique({
    where: { id: session.user.id },
    select: {
      exportWallabagUrl: true,
      exportWallabagClientId: true,
      exportWallabagClientSecret: true,
      exportWallabagUsername: true,
      exportWallabagPassword: true,
    },
  });

  const clientSecret = decryptIfValue(user?.exportWallabagClientSecret, "user.exportWallabagClientSecret");
  const password = decryptIfValue(user?.exportWallabagPassword, "user.exportWallabagPassword");
  if (!user?.exportWallabagUrl || !user.exportWallabagClientId || !clientSecret || !user.exportWallabagUsername || !password) {
    return { success: false, error: "Wallabag is not fully configured" };
  }

  const article = await loadArticleForExport(session.user.id, articleId);
  const config: WallabagConfig = {
    baseUrl: user.exportWallabagUrl,
    clientId: user.exportWallabagClientId,
    clientSecret,
    username: user.exportWallabagUsername,
    password,
  };
  return sendToWallabag(config, {
    url: article.link,
    title: article.title,
    content: await articleAsMarkdown(article),
    tags: ["feedferret"],
  });
}

export async function testReadeckExportConnection(overrides?: {
  readeckUrl?: string;
  readeckApiKey?: string;
}): Promise<{ success: boolean; error?: string }> {
  const session = await requireUser();
  const user = await db.user.findUnique({
    where: { id: session.user.id },
    select: {
      exportReadeckUrl: true,
      exportReadeckApiKey: true,
    },
  });

  const baseUrl = (overrides?.readeckUrl !== undefined ? overrides.readeckUrl : user?.exportReadeckUrl)?.trim();
  const isNewUrl = overrides?.readeckUrl !== undefined && overrides.readeckUrl.trim() !== (user?.exportReadeckUrl || "").trim();
  const apiKey = overrides?.readeckApiKey?.trim() || (!isNewUrl && user?.exportReadeckApiKey ? decryptIfValue(user.exportReadeckApiKey, "user.exportReadeckApiKey") : null);

  if (!baseUrl || !apiKey) {
    if (isNewUrl && !overrides?.readeckApiKey) {
      return { success: false, error: "API token is required when testing a new or modified URL" };
    }
    return { success: false, error: "Fill in the instance URL and API token first" };
  }

  return testReadeckConfig({ baseUrl, apiKey });
}

export async function exportArticleToReadeck(
  articleId: string,
): Promise<{ success: boolean; error?: string }> {
  const session = await requireUser();
  const user = await db.user.findUnique({
    where: { id: session.user.id },
    select: {
      exportReadeckUrl: true,
      exportReadeckApiKey: true,
    },
  });

  const apiKey = decryptIfValue(user?.exportReadeckApiKey, "user.exportReadeckApiKey");
  if (!user?.exportReadeckUrl || !apiKey) {
    return { success: false, error: "Readeck is not fully configured" };
  }

  const article = await loadArticleForExport(session.user.id, articleId);
  return sendToReadeck(
    { baseUrl: user.exportReadeckUrl, apiKey },
    {
      url: article.link,
      title: article.title,
      tags: ["feedferret"],
    },
  );
}

export async function testLinkwardenExportConnection(overrides?: {
  linkwardenUrl?: string;
  linkwardenApiKey?: string;
}): Promise<{ success: boolean; error?: string }> {
  const session = await requireUser();
  const user = await db.user.findUnique({
    where: { id: session.user.id },
    select: {
      exportLinkwardenUrl: true,
      exportLinkwardenApiKey: true,
    },
  });

  const baseUrl = (overrides?.linkwardenUrl !== undefined ? overrides.linkwardenUrl : user?.exportLinkwardenUrl)?.trim();
  const isNewUrl = overrides?.linkwardenUrl !== undefined && overrides.linkwardenUrl.trim() !== (user?.exportLinkwardenUrl || "").trim();
  const apiKey = overrides?.linkwardenApiKey?.trim() || (!isNewUrl && user?.exportLinkwardenApiKey ? decryptIfValue(user.exportLinkwardenApiKey, "user.exportLinkwardenApiKey") : null);

  if (!baseUrl || !apiKey) {
    if (isNewUrl && !overrides?.linkwardenApiKey) {
      return { success: false, error: "API token is required when testing a new or modified URL" };
    }
    return { success: false, error: "Fill in the instance URL and API token first" };
  }

  return testLinkwardenConfig({ baseUrl, apiKey });
}

export async function exportArticleToLinkwarden(
  articleId: string,
): Promise<{ success: boolean; error?: string }> {
  const session = await requireUser();
  const user = await db.user.findUnique({
    where: { id: session.user.id },
    select: {
      exportLinkwardenUrl: true,
      exportLinkwardenApiKey: true,
    },
  });

  const apiKey = decryptIfValue(user?.exportLinkwardenApiKey, "user.exportLinkwardenApiKey");
  if (!user?.exportLinkwardenUrl || !apiKey) {
    return { success: false, error: "Linkwarden is not fully configured" };
  }

  const article = await loadArticleForExport(session.user.id, articleId);
  return sendToLinkwarden(
    { baseUrl: user.exportLinkwardenUrl, apiKey },
    {
      url: article.link,
      title: article.title,
      description: article.content ? (await articleAsMarkdown(article)).slice(0, 500) : undefined,
      tags: ["feedferret"],
    },
  );
}
