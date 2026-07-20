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
import { htmlToMarkdown } from "@/lib/html-to-markdown";
import {
  buildObsidianUrl,
  sendToWallabag,
  testWallabagConfig,
  type WallabagConfig,
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
    },
  });

  const wallabagConfigured = !!(
    user?.exportWallabagUrl &&
    user?.exportWallabagClientId &&
    user?.exportWallabagClientSecret &&
    user?.exportWallabagUsername &&
    user?.exportWallabagPassword
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
    updateData.exportWallabagClientSecret = encryptIfValue(data.wallabagClientSecret);
  }

  if (data.clearWallabagPassword) {
    updateData.exportWallabagPassword = null;
  } else if (data.wallabagPassword) {
    updateData.exportWallabagPassword = encryptIfValue(data.wallabagPassword);
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
  const clientSecret = overrides?.wallabagClientSecret || decryptIfValue(user?.exportWallabagClientSecret);
  const username = overrides?.wallabagUsername || user?.exportWallabagUsername;
  const password = overrides?.wallabagPassword || decryptIfValue(user?.exportWallabagPassword);

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
  return article;
}

function articleAsMarkdown(article: { content: string; contentFormat: string | null }): string {
  if (article.contentFormat === "markdown") return article.content || "";
  try {
    return htmlToMarkdown(article.content || "");
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
    content: articleAsMarkdown(article),
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

  const clientSecret = decryptIfValue(user?.exportWallabagClientSecret);
  const password = decryptIfValue(user?.exportWallabagPassword);
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
    content: articleAsMarkdown(article),
    tags: ["feedferret"],
  });
}
