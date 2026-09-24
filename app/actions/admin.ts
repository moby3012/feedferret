"use server";

import { auth } from "@/auth";
import { db } from "@/lib/db";
import { getConfiguredMailProviders, sendTestSystemEmail, type MailProviderId } from "@/lib/mail";
import { encryptIfValue, decryptIfValue } from "@/lib/crypto";
import { revalidatePath } from "next/cache";
import { normalizeStarterPacksInput, stringifyStarterPacks } from "@/lib/starter-packs";
import { getStarterPacksFromSettings } from "@/lib/starter-packs.server";
import { renderWithConfigDetailed } from "@/lib/render-sidecar";
import { validateRsshubRoute } from "@/lib/rsshub";
import { testChangedetectionConnection as runChangedetectionTest } from "@/lib/changedetection";
import { logger } from "@/lib/logger";

async function checkAdmin() {
  const session = await auth();
  if (session?.user?.role !== "ADMIN") {
    throw new Error("Unauthorized: Admin access required");
  }
  const settings = await db.globalSettings.findUnique({
    where: { id: "global" },
    select: { require2FAForAdmins: true },
  });
  if (settings?.require2FAForAdmins) {
    const user = await db.user.findUnique({
      where: { id: session.user.id! },
      select: { twoFactorEnabled: true },
    });
    if (!user?.twoFactorEnabled) {
      throw new Error(
        "This instance requires admins to have 2FA enabled. Please enable it in Settings → Security.",
      );
    }
  }
  return session;
}

async function logAdminAction(
  actorId: string,
  action: string,
  options?: { targetId?: string; targetEmail?: string; metadata?: Record<string, unknown> },
) {
  try {
    await db.adminAuditLog.create({
      data: {
        actorId,
        action,
        targetId: options?.targetId ?? null,
        targetEmail: options?.targetEmail ?? null,
        metadata: options?.metadata ? JSON.stringify(options.metadata) : null,
      },
    });
  } catch (err) {
    logger.error("[audit]", err);
  }
}

// Sensitive fields stored encrypted in the DB
const ENCRYPTED_FIELDS = [
  "smtpPassword",
  "resendApiKey",
  "postmarkServerToken",
  "mailgunApiKey",
  "sendgridApiKey",
  "renderSidecarToken",
  "rsshubApiKey",
  "changedetectionApiKey",
  "changedetectionRssToken",
] as const;

type EncryptedField = (typeof ENCRYPTED_FIELDS)[number];

function sanitizeSettingsInput(data: Record<string, unknown>) {
  const next: Record<string, unknown> = {};

  if (typeof data.registrationsEnabled === "boolean") next.registrationsEnabled = data.registrationsEnabled;
  if (typeof data.require2FAForAdmins === "boolean") next.require2FAForAdmins = data.require2FAForAdmins;
  if (typeof data.mailServiceEnabled === "boolean") next.mailServiceEnabled = data.mailServiceEnabled;
  if (typeof data.mailProvider === "string") next.mailProvider = data.mailProvider;
  if (typeof data.onboardingCompleted === "boolean") next.onboardingCompleted = data.onboardingCompleted;

  // SMTP
  if ("smtpHost" in data) next.smtpHost = String(data.smtpHost || "").trim() || null;
  if ("smtpUser" in data) next.smtpUser = String(data.smtpUser || "").trim() || null;
  if ("smtpFrom" in data) next.smtpFrom = String(data.smtpFrom || "").trim() || null;
  if ("smtpPort" in data) {
    const port = Number(data.smtpPort);
    next.smtpPort = Number.isFinite(port) && port > 0 ? port : null;
  }
  if ("smtpSecure" in data) {
    const val = String(data.smtpSecure || "").trim();
    next.smtpSecure = ["ssl", "starttls", "plain"].includes(val) ? val : null;
  }
  if ("smtpRejectUnauthorized" in data) {
    next.smtpRejectUnauthorized = data.smtpRejectUnauthorized === false ? false : null;
  }

  // Resend
  if ("resendFromEmail" in data) next.resendFromEmail = String(data.resendFromEmail || "").trim() || null;

  // Postmark
  if ("postmarkFromEmail" in data) next.postmarkFromEmail = String(data.postmarkFromEmail || "").trim() || null;
  if ("postmarkMessageStream" in data) next.postmarkMessageStream = String(data.postmarkMessageStream || "").trim() || null;

  // Mailgun
  if ("mailgunDomain" in data) next.mailgunDomain = String(data.mailgunDomain || "").trim() || null;
  if ("mailgunFromEmail" in data) next.mailgunFromEmail = String(data.mailgunFromEmail || "").trim() || null;
  if ("mailgunBaseUrl" in data) next.mailgunBaseUrl = String(data.mailgunBaseUrl || "").trim() || null;

  // SendGrid
  if ("sendgridFromEmail" in data) next.sendgridFromEmail = String(data.sendgridFromEmail || "").trim() || null;

  // Instance
  if ("instanceName" in data) next.instanceName = String(data.instanceName || "").trim() || null;
  if ("instanceUrl" in data) next.instanceUrl = String(data.instanceUrl || "").trim() || null;
  if ("instanceIconDataUrl" in data) {
    const value = String(data.instanceIconDataUrl || "").trim();
    if (value && (!value.startsWith("data:image/") || value.length > 250_000)) {
      throw new Error("Logo must be an image data URL smaller than 250 KB");
    }
    next.instanceIconDataUrl = value || null;
  }
  if ("starterPacksJson" in data) {
    const value = String(data.starterPacksJson || "").trim();
    if (value) {
      const parsed = JSON.parse(value);
      const result = normalizeStarterPacksInput(parsed);
      if (result.errors.length > 0) {
        throw new Error(result.errors.join("; "));
      }
      next.starterPacksJson = stringifyStarterPacks(result.packs);
    } else {
      next.starterPacksJson = null;
    }
  }

  // Misc
  if ("totpIssuer" in data) next.totpIssuer = String(data.totpIssuer || "").trim() || null;
  if (typeof data.backgroundSyncEnabled === "boolean") next.backgroundSyncEnabled = data.backgroundSyncEnabled;
  if (typeof data.allowInternalFeedUrls === "boolean") next.allowInternalFeedUrls = data.allowInternalFeedUrls;
  if ("backgroundSyncIntervalMinutes" in data) {
    const v = Number(data.backgroundSyncIntervalMinutes);
    next.backgroundSyncIntervalMinutes = Number.isFinite(v) && v > 0 ? v : 5;
  }

  // Browser-render sidecar (M7-T2)
  if (typeof data.renderSidecarEnabled === "boolean") next.renderSidecarEnabled = data.renderSidecarEnabled;
  if ("renderSidecarUrl" in data) {
    const value = String(data.renderSidecarUrl || "").trim();
    if (value && !/^https?:\/\//i.test(value)) {
      throw new Error("Render sidecar URL must start with http:// or https://");
    }
    next.renderSidecarUrl = value || null;
  }

  // RSSHub connector (M5a)
  if (typeof data.rsshubEnabled === "boolean") next.rsshubEnabled = data.rsshubEnabled;
  if ("rsshubBaseUrl" in data) {
    const value = String(data.rsshubBaseUrl || "").trim();
    if (value && !/^https?:\/\//i.test(value)) {
      throw new Error("RSSHub base URL must start with http:// or https://");
    }
    next.rsshubBaseUrl = value || null;
  }

  // changedetection.io connector (M5b)
  if (typeof data.changedetectionEnabled === "boolean") next.changedetectionEnabled = data.changedetectionEnabled;
  if ("changedetectionBaseUrl" in data) {
    const value = String(data.changedetectionBaseUrl || "").trim();
    if (value && !/^https?:\/\//i.test(value)) {
      throw new Error("changedetection.io base URL must start with http:// or https://");
    }
    next.changedetectionBaseUrl = value || null;
  }

  // Encrypted fields: only update if a non-empty value is provided
  // (empty string = "don't change the stored value")
  for (const field of ENCRYPTED_FIELDS) {
    if (field in data) {
      const val = String(data[field] || "").trim();
      if (val) {
        next[field] = encryptIfValue(val);
      }
      // If empty, skip — preserve existing encrypted value
    }
  }

  return next;
}

async function assertMailProviderAllowed(provider: string, storedSettings?: any) {
  const allowed = (await getConfiguredMailProviders(storedSettings)).map((option) => option.id);
  if (!allowed.includes(provider as MailProviderId)) {
    throw new Error("Selected mail provider is not configured");
  }
}

function decryptSettingsForDisplay(settings: any) {
  const displayable = { ...settings };
  for (const field of ENCRYPTED_FIELDS) {
    if (displayable[field]) {
      // Return a sentinel so UI knows there's a value but doesn't expose it
      displayable[field] = "__encrypted__";
    }
  }
  return displayable;
}

export async function getUsers() {
  await checkAdmin();
  return db.user.findMany({
    orderBy: { createdAt: "desc" },
    select: {
      id: true,
      name: true,
      email: true,
      role: true,
      image: true,
      isActive: true,
      createdAt: true,
    },
  });
}

export async function updateUserRole(userId: string, role: string) {
  const session = await checkAdmin();
  if (!["ADMIN", "USER"].includes(role)) {
    throw new Error("Invalid role");
  }
  if (session.user.id === userId && role !== "ADMIN") {
    throw new Error("You cannot remove your own admin rights");
  }
  const target = await db.user.findUnique({ where: { id: userId }, select: { role: true, email: true } });
  if (role !== "ADMIN") {
    const adminCount = await db.user.count({ where: { role: "ADMIN" } });
    if (target?.role === "ADMIN" && adminCount <= 1) {
      throw new Error("Cannot remove the last admin");
    }
  }
  await db.user.update({ where: { id: userId }, data: { role } });
  await logAdminAction(session.user.id!, "user.role_change", {
    targetId: userId,
    targetEmail: target?.email ?? undefined,
    metadata: { from: target?.role, to: role },
  });
  revalidatePath("/");
}

export async function suspendUser(userId: string) {
  const session = await checkAdmin();
  const target = await db.user.findUnique({ where: { id: userId }, select: { email: true } });
  await db.user.update({ where: { id: userId }, data: { isActive: false } });
  await logAdminAction(session.user.id!, "user.suspend", { targetId: userId, targetEmail: target?.email ?? undefined });
  revalidatePath("/");
}

export async function unsuspendUser(userId: string) {
  const session = await checkAdmin();
  const target = await db.user.findUnique({ where: { id: userId }, select: { email: true } });
  await db.user.update({ where: { id: userId }, data: { isActive: true } });
  await logAdminAction(session.user.id!, "user.unsuspend", { targetId: userId, targetEmail: target?.email ?? undefined });
  revalidatePath("/");
}

export async function deleteUser(userId: string) {
  const session = await checkAdmin();
  if (session.user.id === userId) {
    throw new Error("Cannot delete your own account");
  }
  const target = await db.user.findUnique({ where: { id: userId }, select: { email: true } });
  await db.user.delete({ where: { id: userId } });
  await logAdminAction(session.user.id!, "user.delete", { targetId: userId, targetEmail: target?.email ?? undefined });
  revalidatePath("/");
}

export async function getGlobalSettings() {
  await checkAdmin();

  let settings = await db.globalSettings.findUnique({ where: { id: "global" } });
  if (!settings) {
    settings = await db.globalSettings.create({ data: { id: "global" } });
  }

  const availableMailProviders = await getConfiguredMailProviders(settings);
  const allowedIds = availableMailProviders.map((option) => option.id);
  const normalizedMailProvider = allowedIds.includes(settings.mailProvider as MailProviderId)
    ? settings.mailProvider
    : "smtp";

  return {
    ...decryptSettingsForDisplay(settings),
    mailProvider: normalizedMailProvider,
    availableMailProviders,
    starterPacks: await getStarterPacksFromSettings(settings.starterPacksJson),
  };
}

export async function updateGlobalSettings(data: Record<string, unknown>) {
  await checkAdmin();
  const sanitized = sanitizeSettingsInput(data);

  if (typeof sanitized.mailProvider === "string") {
    // Fetch current settings to merge with new ones for provider validation
    const current = await db.globalSettings.findUnique({ where: { id: "global" } });
    const merged = { ...current, ...sanitized };
    await assertMailProviderAllowed(sanitized.mailProvider, merged);
  }

  await db.globalSettings.upsert({
    where: { id: "global" },
    update: sanitized,
    create: { id: "global", ...sanitized },
  });

  const session = await auth();
  if (session?.user?.id) {
    await logAdminAction(session.user.id, "settings.update", {
      metadata: {
        fields: Object.keys(sanitized),
        ...(sanitized.smtpRejectUnauthorized === false ? { smtpRejectUnauthorized: false } : {}),
      },
    });
  }

  revalidatePath("/");
}

export async function sendTestEmail(config: Record<string, unknown>) {
  const session = await checkAdmin();
  if (!session.user.email) {
    throw new Error("Admin account needs an email address for the test message");
  }

  // For test: if API key is the sentinel, read from DB
  const current = await db.globalSettings.findUnique({ where: { id: "global" } });
  const sanitized = sanitizeSettingsInput(config);

  // Merge: current DB values for encrypted fields where UI sent sentinel
  const testSettings: any = { ...current };
  for (const [k, v] of Object.entries(sanitized)) {
    if (v !== undefined) testSettings[k] = v;
  }
  // For encrypted fields that weren't changed in the UI (sentinel), keep the DB value
  for (const field of ENCRYPTED_FIELDS) {
    if ((config[field] as string) === "__encrypted__" && current?.[field]) {
      testSettings[field] = current[field];
    }
  }

  const provider = String(testSettings.mailProvider || "smtp");

  const adminUser = await db.user.findUnique({ where: { id: session.user.id }, select: { uiLanguage: true } });
  try {
    await sendTestSystemEmail(
      session.user.email,
      { ...testSettings, mailServiceEnabled: true, mailProvider: provider },
      adminUser?.uiLanguage ?? "en",
    );
    return { success: true, sentTo: session.user.email };
  } catch (error: any) {
    logger.error("Mail provider test failed:", error);
    return { success: false, error: error?.message || "Unknown mail error" };
  }
}

export async function testRenderSidecar(config: { url?: string; token?: string; testUrl?: string }) {
  await checkAdmin();
  const url = String(config.url || "").trim();
  if (!/^https?:\/\//i.test(url)) {
    return { success: false as const, error: "Render sidecar URL must start with http:// or https://" };
  }

  // The token field may carry the "__encrypted__" sentinel when the admin left
  // the stored value untouched — resolve it back to the stored token.
  let token = String(config.token || "").trim() || null;
  if (token === "__encrypted__") {
    const current = await db.globalSettings.findUnique({
      where: { id: "global" },
      select: { renderSidecarToken: true },
    });
    token = decryptIfValue(current?.renderSidecarToken) || null;
  }

  const testUrl = String(config.testUrl || "").trim() || "https://example.com/";
  try {
    const result = await renderWithConfigDetailed({ url, token }, testUrl, {
      context: "Render sidecar test",
      timeoutMs: 30_000,
    });
    if (!result.ok) {
      return { success: false as const, error: result.reason };
    }
    if (result.html.trim().length < 50) {
      return {
        success: false as const,
        error: `Sidecar responded but the extracted content was too short to be useful (${result.html.length} chars)`,
      };
    }
    return { success: true as const, bytes: result.html.length, testUrl };
  } catch (error: any) {
    logger.error("Render sidecar test failed:", error);
    return { success: false as const, error: error?.message || "Unknown render sidecar error" };
  }
}

// RSSHub's own GitHub releases route: always exists, no platform auth needed
// — a reliable smoke test for "is this RSSHub instance reachable and serving
// real feeds" independent of whatever route a user later asks for.
const RSSHUB_TEST_ROUTE = "/github/repos/DIYgod/RSSHub/releases";

export async function testRsshubConnection(config: { baseUrl?: string; apiKey?: string; testRoute?: string }) {
  await checkAdmin();
  const baseUrl = String(config.baseUrl || "").trim();
  if (!/^https?:\/\//i.test(baseUrl)) {
    return { success: false as const, error: "RSSHub base URL must start with http:// or https://" };
  }

  // The key field may carry the "__encrypted__" sentinel when the admin left
  // the stored value untouched — resolve it back to the stored key.
  let apiKey = String(config.apiKey || "").trim() || null;
  if (apiKey === "__encrypted__") {
    const current = await db.globalSettings.findUnique({
      where: { id: "global" },
      select: { rsshubApiKey: true },
    });
    apiKey = decryptIfValue(current?.rsshubApiKey) || null;
  }

  const testRoute = String(config.testRoute || "").trim() || RSSHUB_TEST_ROUTE;
  const result = await validateRsshubRoute({ baseUrl, apiKey }, testRoute);
  if (!result.ok) {
    return { success: false as const, error: result.reason };
  }
  return { success: true as const, itemCount: result.itemCount, testRoute };
}

export async function testChangedetectionConnection(config: { baseUrl?: string; apiKey?: string; rssToken?: string }) {
  await checkAdmin();
  const baseUrl = String(config.baseUrl || "").trim();
  if (!/^https?:\/\//i.test(baseUrl)) {
    return { success: false as const, error: "changedetection.io base URL must start with http:// or https://" };
  }

  // These fields may carry the "__encrypted__" sentinel when the admin left
  // the stored value untouched — resolve them back to the stored secrets.
  let apiKey = String(config.apiKey || "").trim();
  let rssToken = String(config.rssToken || "").trim();
  if (apiKey === "__encrypted__" || rssToken === "__encrypted__") {
    const current = await db.globalSettings.findUnique({
      where: { id: "global" },
      select: { changedetectionApiKey: true, changedetectionRssToken: true },
    });
    if (apiKey === "__encrypted__") apiKey = decryptIfValue(current?.changedetectionApiKey) || "";
    if (rssToken === "__encrypted__") rssToken = decryptIfValue(current?.changedetectionRssToken) || "";
  }
  if (!apiKey) {
    return { success: false as const, error: "An API key is required (Settings → API in your changedetection.io instance)." };
  }

  const result = await runChangedetectionTest({ baseUrl, apiKey, rssToken });
  if (!result.ok) {
    return { success: false as const, error: result.reason };
  }
  return {
    success: true as const,
    version: result.version,
    discoveredRssToken: result.discoveredRssToken,
    rssTokenDiscoveryError: result.rssTokenDiscoveryError,
  };
}

export async function getPushDiagnostics() {
  await checkAdmin();
  const publicKey = process.env.WEB_PUSH_VAPID_PUBLIC_KEY || "";
  const privateKeyConfigured = Boolean(process.env.WEB_PUSH_VAPID_PRIVATE_KEY);
  const contact = process.env.WEB_PUSH_CONTACT || "";
  const configured = Boolean(publicKey && privateKeyConfigured && contact);

  const [activeSubscriptions, totalUsers] = await Promise.all([
    db.pushSubscription.count({ where: { disabledAt: null } }),
    db.user.count({}),
  ]);

  return {
    configured,
    publicKey: publicKey ? `${publicKey.slice(0, 10)}…${publicKey.slice(-6)}` : "",
    contact,
    privateKeyConfigured,
    activeSubscriptions,
    totalUsers,
  };
}

export async function generateVapidKeyPair() {
  await checkAdmin();
  const webpush = (await import("web-push")).default;
  const keys = webpush.generateVAPIDKeys();
  return {
    publicKey: keys.publicKey,
    privateKey: keys.privateKey,
  };
}

export async function getAdminAuditLog(limit = 100) {
  await checkAdmin();
  return db.adminAuditLog.findMany({
    orderBy: { createdAt: "desc" },
    take: limit,
    include: { actor: { select: { name: true, email: true } } },
  });
}

export async function getLoginAttempts(limit = 100) {
  await checkAdmin();
  return db.loginAttempt.findMany({
    orderBy: { createdAt: "desc" },
    take: limit,
    select: { id: true, email: true, success: true, failReason: true, ip: true, createdAt: true },
  });
}

export async function getSystemLogs(limit = 200, category?: string) {
  await checkAdmin();
  return db.systemLog.findMany({
    orderBy: { createdAt: "desc" },
    take: limit,
    where: category ? { category } : undefined,
  });
}

export async function getStorageStats() {
  await checkAdmin();

  const users = await db.user.findMany({
    select: { id: true, name: true, email: true },
    orderBy: { createdAt: "asc" },
  });

  const [articleCounts, feedCounts, summaryCount, labelCounts] = await Promise.all([
    db.article.groupBy({ by: ["userId"], _count: { _all: true } }),
    db.feed.groupBy({ by: ["userId"], _count: { _all: true } }),
    db.article.groupBy({ by: ["userId"], where: { aiSummary: { not: null } }, _count: { _all: true } }),
    db.articleLabel.groupBy({ by: ["userId"], _count: { _all: true } }),
  ]);

  type UserCount = { userId: string; _count: { _all: number } };
  const articleMap = new Map(articleCounts.map((r: UserCount) => [r.userId, r._count._all]));
  const feedMap = new Map(feedCounts.map((r: UserCount) => [r.userId, r._count._all]));
  const summaryMap = new Map(summaryCount.map((r: UserCount) => [r.userId, r._count._all]));
  const labelMap = new Map(labelCounts.map((r: UserCount) => [r.userId, r._count._all]));

  return users.map((u: { id: string; name: string | null; email: string | null }) => ({
    id: u.id,
    name: u.name,
    email: u.email,
    articles: articleMap.get(u.id) ?? 0,
    feeds: feedMap.get(u.id) ?? 0,
    aiSummaries: summaryMap.get(u.id) ?? 0,
    labeledArticles: labelMap.get(u.id) ?? 0,
  }));
}
