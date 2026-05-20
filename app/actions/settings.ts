"use server";

import { auth } from "@/auth";
import { db } from "@/lib/db";
import { revalidatePath } from "next/cache";
import { randomBytes } from "crypto";
import { sendDigestEmail, getDigestArticles } from "@/lib/digest-email";
import { buildOtpAuthUri, generateTotpSecret, verifyTotpToken } from "@/lib/totp";
import { encryptIfValue, decryptIfValue } from "@/lib/crypto";
import type { AiProvider } from "@/lib/ai-summary";

async function requireUser() {
  const session = await auth();
  if (!session?.user?.id) throw new Error("Unauthorized");
  return session;
}

export async function updateProfile(data: { name?: string; email?: string }) {
  const session = await requireUser();

  await db.user.update({
    where: { id: session.user.id },
    data,
  });

  revalidatePath("/");
}

export async function getReadingPreferences() {
  const session = await requireUser();
  const user = await db.user.findUnique({
    where: { id: session.user.id },
    select: {
      openOriginalByDefault: true,
      markReadAfterDelaySecs: true,
      defaultViewMode: true,
      readerWidth: true,
      readerFontSize: true,
      defaultArticleSort: true,
      accentColor: true,
      secondaryColor: true,
      hideDuplicates: true,
      markReadOnScroll: true,
      layoutDirection: true,
      hideEmptyFeeds: true,
      uiLanguage: true,
    },
  });
  return {
    openOriginalByDefault: user?.openOriginalByDefault ?? false,
    markReadAfterDelaySecs: user?.markReadAfterDelaySecs ?? null,
    defaultViewMode: user?.defaultViewMode ?? "list",
    readerWidth: user?.readerWidth ?? "normal",
    readerFontSize: user?.readerFontSize ?? "medium",
    defaultArticleSort: user?.defaultArticleSort ?? "newest",
    accentColor: user?.accentColor ?? "#5BA4CF",
    secondaryColor: user?.secondaryColor ?? "#F0963C",
    hideDuplicates: user?.hideDuplicates ?? true,
    markReadOnScroll: user?.markReadOnScroll ?? false,
    layoutDirection: (user?.layoutDirection === "rtl" ? "rtl" : "ltr") as "ltr" | "rtl",
    hideEmptyFeeds: user?.hideEmptyFeeds ?? false,
    uiLanguage: user?.uiLanguage ?? "en",
  };
}

export async function updateGlobalSettings(data: {
  defaultUpdateFrequency?: number;
  defaultRetentionDays?: number;
  openOriginalByDefault?: boolean;
  markReadAfterDelaySecs?: number | null;
  defaultViewMode?: string;
  readerWidth?: string;
  readerFontSize?: string;
  defaultArticleSort?: string;
  accentColor?: string;
  secondaryColor?: string;
  hideDuplicates?: boolean;
  markReadOnScroll?: boolean;
  layoutDirection?: "ltr" | "rtl";
  hideEmptyFeeds?: boolean;
}) {
  const session = await requireUser();

  await db.user.update({
    where: { id: session.user.id },
    data,
  });

  revalidatePath("/");
}

export async function getTwoFactorStatus() {
  const session = await requireUser();
  const user = await db.user.findUnique({
    where: { id: session.user.id },
    select: { twoFactorEnabled: true },
  });

  return { enabled: !!user?.twoFactorEnabled };
}

export async function beginTwoFactorSetup() {
  const session = await requireUser();
  const user = await db.user.findUnique({
    where: { id: session.user.id },
    select: { email: true, twoFactorEnabled: true },
  });

  if (!user?.email) {
    throw new Error("You need an email address on your account before enabling 2FA");
  }
  if (user.twoFactorEnabled) {
    throw new Error("Two-factor authentication is already enabled");
  }

  const secret = generateTotpSecret();
  const issuer = process.env.TOTP_ISSUER || "FeedFerret";
  const uri = buildOtpAuthUri({
    secret,
    issuer,
    accountName: user.email,
  });

  await db.user.update({
    where: { id: session.user.id },
    data: {
      twoFactorEnabled: false,
      twoFactorSecret: secret,
    },
  });

  return { secret, uri, issuer, accountName: user.email };
}

export async function confirmTwoFactorSetup(code: string) {
  const session = await requireUser();
  const user = await db.user.findUnique({
    where: { id: session.user.id },
    select: { twoFactorSecret: true },
  });

  if (!user?.twoFactorSecret) {
    throw new Error("Start setup first");
  }

  if (!verifyTotpToken(user.twoFactorSecret, code)) {
    throw new Error("Invalid one-time code");
  }

  await db.user.update({
    where: { id: session.user.id },
    data: { twoFactorEnabled: true, sessionVersion: { increment: 1 } },
  });

  revalidatePath("/settings");
  return { enabled: true };
}

export async function disableTwoFactor(code: string) {
  const session = await requireUser();
  const user = await db.user.findUnique({
    where: { id: session.user.id },
    select: { twoFactorEnabled: true, twoFactorSecret: true },
  });

  if (!user?.twoFactorEnabled || !user.twoFactorSecret) {
    throw new Error("Two-factor authentication is not enabled");
  }

  if (!verifyTotpToken(user.twoFactorSecret, code)) {
    throw new Error("Invalid one-time code");
  }

  await db.user.update({
    where: { id: session.user.id },
    data: {
      twoFactorEnabled: false,
      twoFactorSecret: null,
      sessionVersion: { increment: 1 },
    },
  });

  revalidatePath("/settings");
  return { enabled: false };
}

export async function getDigestSettings() {
  const session = await requireUser();

  const user = await db.user.findUnique({
    where: { id: session.user.id },
    select: {
      digestEnabled: true,
      digestFrequency: true,
      digestDayOfWeek: true,
      digestHour: true,
      digestScope: true,
      digestFeedIds: true,
      digestLastSentAt: true,
    },
  });

  return {
    digestEnabled: user?.digestEnabled ?? false,
    digestFrequency: user?.digestFrequency ?? "daily",
    digestDayOfWeek: user?.digestDayOfWeek ?? 1,
    digestHour: user?.digestHour ?? 8,
    digestScope: user?.digestScope ?? "unread",
    digestFeedIds: user?.digestFeedIds ? (JSON.parse(user.digestFeedIds) as string[]) : [],
    digestLastSentAt: user?.digestLastSentAt ?? null,
  };
}

export async function updateDigestSettings(data: {
  digestEnabled?: boolean;
  digestFrequency?: string;
  digestDayOfWeek?: number;
  digestHour?: number;
  digestScope?: string;
  digestFeedIds?: string[];
}) {
  const session = await requireUser();

  const updateData: Record<string, unknown> = { ...data };

  if (data.digestFeedIds !== undefined) {
    updateData.digestFeedIds =
      data.digestFeedIds.length > 0 ? JSON.stringify(data.digestFeedIds) : null;
  }

  if (data.digestEnabled) {
    const user = await db.user.findUnique({
      where: { id: session.user.id },
      select: { digestUnsubscribeToken: true },
    });
    if (!user?.digestUnsubscribeToken) {
      updateData.digestUnsubscribeToken = randomBytes(32).toString("hex");
    }
  }

  await db.user.update({
    where: { id: session.user.id },
    data: updateData,
  });

  revalidatePath("/settings");
}

export async function sendTestDigest() {
  const session = await requireUser();
  if (!session.user.email) throw new Error("Unauthorized");

  const user = await db.user.findUnique({
    where: { id: session.user.id },
    select: {
      name: true,
      email: true,
      digestScope: true,
      digestFeedIds: true,
      digestUnsubscribeToken: true,
    },
  });

  if (!user?.email) throw new Error("No email address on account");

  let token = user.digestUnsubscribeToken;
  if (!token) {
    token = randomBytes(32).toString("hex");
    await db.user.update({
      where: { id: session.user.id },
      data: { digestUnsubscribeToken: token },
    });
  }

  const feedIds: string[] | null = user.digestFeedIds ? JSON.parse(user.digestFeedIds) : null;
  const since = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
  const articles = await getDigestArticles(session.user.id, user.digestScope, feedIds, since);
  const baseUrl = process.env.AUTH_URL?.replace(/\/$/, "") ?? "http://localhost:3000";

  await sendDigestEmail({
    to: user.email,
    userName: user.name,
    articles,
    unsubscribeToken: token,
    baseUrl,
  });

  return { sent: true, articleCount: articles.length };
}

export async function getAiSettings() {
  const session = await requireUser();
  const user = await db.user.findUnique({
    where: { id: session.user.id },
    select: {
      aiProvider: true,
      aiApiKey: true,
      aiModel: true,
      aiOllamaBaseUrl: true,
      aiAutoSummarize: true,
      aiSummaryLanguage: true,
    },
  });
  return {
    provider: user?.aiProvider ?? null,
    hasApiKey: !!user?.aiApiKey,
    model: user?.aiModel ?? null,
    ollamaBaseUrl: user?.aiOllamaBaseUrl ?? null,
    autoSummarize: user?.aiAutoSummarize ?? false,
    language: user?.aiSummaryLanguage ?? "same",
  };
}

export async function updateAiSettings(data: {
  provider?: string | null;
  apiKey?: string | null;
  clearApiKey?: boolean;
  model?: string | null;
  ollamaBaseUrl?: string | null;
  autoSummarize?: boolean;
  language?: string;
}) {
  const session = await requireUser();
  const updateData: Record<string, unknown> = {};
  if ("provider" in data) updateData.aiProvider = data.provider;
  if (data.clearApiKey) {
    updateData.aiApiKey = null;
  } else if (data.apiKey) {
    updateData.aiApiKey = encryptIfValue(data.apiKey);
  }
  if ("model" in data) updateData.aiModel = data.model;
  if ("ollamaBaseUrl" in data) updateData.aiOllamaBaseUrl = data.ollamaBaseUrl;
  if ("autoSummarize" in data) updateData.aiAutoSummarize = data.autoSummarize;
  if ("language" in data) updateData.aiSummaryLanguage = data.language;
  await db.user.update({ where: { id: session.user.id }, data: updateData });
  revalidatePath("/settings");
}

export async function testAiConnection(): Promise<{ success: boolean; error?: string }> {
  const session = await requireUser();
  const user = await db.user.findUnique({
    where: { id: session.user.id },
    select: { aiProvider: true, aiApiKey: true, aiModel: true, aiOllamaBaseUrl: true },
  });
  if (!user?.aiProvider) return { success: false, error: "No AI provider configured" };
  try {
    const { generateSummary } = await import("@/lib/ai-summary");
    await generateSummary("Short test content for connectivity verification.", {
      provider: user.aiProvider as AiProvider,
      apiKey: decryptIfValue(user.aiApiKey),
      model: user.aiModel,
      ollamaBaseUrl: user.aiOllamaBaseUrl,
    });
    return { success: true };
  } catch (err) {
    return { success: false, error: err instanceof Error ? err.message : String(err) };
  }
}

// ─── Notification Channels ──────────────────────────────────────────────────

export async function getNotificationChannels() {
  const session = await requireUser();
  const user = await db.user.findUnique({
    where: { id: session.user.id },
    select: {
      telegramEnabled: true,
      telegramBotToken: true,
      telegramChatId: true,
      gotifyEnabled: true,
      gotifyUrl: true,
      gotifyToken: true,
      ntfyEnabled: true,
      ntfyUrl: true,
      ntfyToken: true,
    },
  });
  return {
    telegramEnabled: user?.telegramEnabled ?? false,
    telegramBotToken: user?.telegramBotToken ?? "",
    telegramChatId: user?.telegramChatId ?? "",
    gotifyEnabled: user?.gotifyEnabled ?? false,
    gotifyUrl: user?.gotifyUrl ?? "",
    gotifyToken: user?.gotifyToken ?? "",
    ntfyEnabled: user?.ntfyEnabled ?? false,
    ntfyUrl: user?.ntfyUrl ?? "",
    ntfyToken: user?.ntfyToken ?? "",
  };
}

export async function updateNotificationChannels(data: {
  telegramEnabled?: boolean;
  telegramBotToken?: string;
  telegramChatId?: string;
  gotifyEnabled?: boolean;
  gotifyUrl?: string;
  gotifyToken?: string;
  ntfyEnabled?: boolean;
  ntfyUrl?: string;
  ntfyToken?: string;
}) {
  const session = await requireUser();
  const sanitized: Record<string, unknown> = {};

  if (data.telegramEnabled !== undefined) sanitized.telegramEnabled = data.telegramEnabled;
  if (data.telegramBotToken !== undefined) sanitized.telegramBotToken = data.telegramBotToken.trim() || null;
  if (data.telegramChatId !== undefined) sanitized.telegramChatId = data.telegramChatId.trim() || null;
  if (data.gotifyEnabled !== undefined) sanitized.gotifyEnabled = data.gotifyEnabled;
  if (data.gotifyUrl !== undefined) sanitized.gotifyUrl = data.gotifyUrl.trim() || null;
  if (data.gotifyToken !== undefined) sanitized.gotifyToken = data.gotifyToken.trim() || null;
  if (data.ntfyEnabled !== undefined) sanitized.ntfyEnabled = data.ntfyEnabled;
  if (data.ntfyUrl !== undefined) sanitized.ntfyUrl = data.ntfyUrl.trim() || null;
  if (data.ntfyToken !== undefined) sanitized.ntfyToken = data.ntfyToken.trim() || null;

  await db.user.update({ where: { id: session.user.id }, data: sanitized });
  revalidatePath("/settings");
}

export async function getNotificationChannelStatus() {
  const session = await auth();
  if (!session?.user?.id) return { push: false, email: false, telegram: false, gotify: false, ntfy: false };
  const user = await db.user.findUnique({
    where: { id: session.user.id },
    select: {
      telegramEnabled: true, telegramBotToken: true, telegramChatId: true,
      gotifyEnabled: true, gotifyUrl: true, gotifyToken: true,
      ntfyEnabled: true, ntfyUrl: true, ntfyToken: true,
    },
  });
  const settings = await db.globalSettings.findUnique({ where: { id: "global" }, select: { mailServiceEnabled: true } });
  const pushCount = await db.pushSubscription.count({ where: { userId: session.user.id } });
  return {
    push: pushCount > 0,
    email: settings?.mailServiceEnabled ?? false,
    telegram: !!(user?.telegramEnabled && user.telegramBotToken && user.telegramChatId),
    gotify: !!(user?.gotifyEnabled && user.gotifyUrl && user.gotifyToken),
    ntfy: !!(user?.ntfyEnabled && user.ntfyUrl),
  };
}

export async function testNotificationChannel(
  channel: "telegram" | "gotify" | "ntfy",
): Promise<{ success: boolean; error?: string }> {
  const session = await requireUser();
  const user = await db.user.findUnique({
    where: { id: session.user.id },
    select: {
      telegramBotToken: true, telegramChatId: true,
      gotifyUrl: true, gotifyToken: true,
      ntfyUrl: true, ntfyToken: true,
    },
  });

  const {
    sendTelegramNotification,
    sendGotifyNotification,
    sendNtfyNotification,
  } = await import("@/lib/notification-channels");

  const testPayload = {
    title: "FeedFerret test notification",
    body: "This is a test from your FeedFerret instance. Notifications are working correctly.",
  };

  try {
    let result: { ok: boolean; error?: string };
    if (channel === "telegram") {
      if (!user?.telegramBotToken || !user.telegramChatId)
        return { success: false, error: "Bot token and Chat ID are required" };
      result = await sendTelegramNotification(
        { botToken: user.telegramBotToken, chatId: user.telegramChatId },
        testPayload,
      );
    } else if (channel === "gotify") {
      if (!user?.gotifyUrl || !user.gotifyToken)
        return { success: false, error: "Server URL and token are required" };
      result = await sendGotifyNotification(
        { url: user.gotifyUrl, token: user.gotifyToken },
        testPayload,
      );
    } else if (channel === "ntfy") {
      if (!user?.ntfyUrl)
        return { success: false, error: "Topic URL is required" };
      result = await sendNtfyNotification(
        { url: user.ntfyUrl, token: user.ntfyToken ?? undefined },
        testPayload,
      );
    } else {
      return { success: false, error: "Unknown channel" };
    }
    return { success: result.ok, error: result.error };
  } catch (err) {
    return { success: false, error: err instanceof Error ? err.message : String(err) };
  }
}
