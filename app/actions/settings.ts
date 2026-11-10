"use server";

import { auth } from "@/auth";
import { db } from "@/lib/db";
import { revalidatePath } from "next/cache";
import { randomBytes } from "crypto";
import bcrypt from "bcryptjs";
import { sendDigestEmail, getDigestArticles, markArticlesAsDigested } from "@/lib/digest-email";
import { buildOtpAuthUri, generateTotpSecret, verifyTotpToken } from "@/lib/totp";
import { encryptIfValue, decryptIfValue } from "@/lib/crypto";
import { ChangePasswordSchema } from "@/lib/validation";
import type { AiProvider } from "@/lib/ai-summary";
import { fetchViaHostedApiDetailed, type HostedFetchProvider } from "@/lib/hosted-fetch";
import { loadReadingPreferences } from "@/server/bootstrap";
import { isCountDisplay, type CountDisplay } from "@/lib/count-display";
import { pickFields } from "@/lib/pick-fields";
import { verifyStepUp } from "@/lib/step-up";
import { checkRateLimit } from "@/lib/rate-limit";

async function requireUser() {
  const session = await auth();
  if (!session?.user?.id) throw new Error("Unauthorized");
  return session;
}

export type UpdateProfileResult =
    | {
          success: true;
          emailChanged: boolean;
          feverRotationRequired: boolean;
          /** Email change only: "sent" = old + new address notified, "failed" = mail configured but a send failed, "unavailable" = no mail delivery. */
          emailNotice?: "sent" | "failed" | "unavailable";
      }
    | { success: false; code: "stepUpRequired" | "reloginRequired" | "rateLimited" | "invalidEmail" | "emailTaken" };

function isUniqueViolation(error: unknown): boolean {
  return !!error && typeof error === "object" && (error as { code?: unknown }).code === "P2002";
}

/** Whether an email change can send the confirmation / old-address notice (UI warns when not). */
export async function getEmailChangeMailStatus(): Promise<{ mailConfigured: boolean }> {
  await requireUser();
  const { isMailServiceEnabled } = await import("@/lib/mail");
  return { mailConfigured: await isMailServiceEnabled() };
}

export async function updateProfile(data: {
    name?: string;
    email?: string;
    /** Step-up for an email change (N17): current password, or a TOTP code. */
    currentPassword?: string;
    totp?: string;
}): Promise<UpdateProfileResult> {
  const session = await requireUser();

  const profile = pickFields(data, ["name", "email"] as const);
  for (const [key, value] of Object.entries(profile)) {
    if (value !== null && typeof value !== "string") throw new Error(`Invalid ${key}`);
  }
  // Login identities are compared case-insensitively by mail providers and the
  // magic-link flow lower-cases them: store the normalized form.
  if (typeof profile.email === "string") profile.email = profile.email.trim().toLowerCase();

  const current = await db.user.findUniqueOrThrow({ where: { id: session.user.id }, select: { email: true, uiLanguage: true } });
  if (profile.email !== undefined && profile.email !== current.email) {
    // The account email is the login identity (and the GReader/Fever username).
    if (typeof profile.email !== "string" || !/^[^\s@]+@[^\s@]+$/.test(profile.email) || profile.email.length > 254) {
      return { success: false, code: "invalidEmail" };
    }
    // Changing the login email hands the account to whoever owns the new
    // address (magic link / password reset), so a stolen or borrowed session
    // alone must not be enough: same step-up as the API password (#227).
    const limit = checkRateLimit(session.user.id, { prefix: "email-change-step-up", limit: 10, windowSecs: 900 });
    if (!limit.success) return { success: false, code: "rateLimited" };
    const stepUp = await verifyStepUp(
      { id: session.user.id, authenticatedAt: (session as { authenticatedAt?: number }).authenticatedAt },
      { currentPassword: data?.currentPassword, totp: data?.totp },
    );
    if (!stepUp.ok) return { success: false, code: stepUp.code };
    // Checked after the step-up so a bare session can't probe which addresses exist.
    const taken = await db.user.findFirst({ where: { email: profile.email, NOT: { id: session.user.id } }, select: { id: true } });
    if (taken) return { success: false, code: "emailTaken" };
  }

  let emailChanged: boolean;
  try {
    emailChanged = await db.$transaction(async (tx) => {
    const previous = await tx.user.findUniqueOrThrow({ where: { id: session.user.id }, select: { email: true } });
    const emailChanged = profile.email !== undefined && profile.email !== previous.email;
    // A concurrent change between the step-up check and here would compare
    // against a different address than the one the user re-authenticated for.
    if (emailChanged && previous.email !== current.email) throw new Error("Profile changed concurrently, try again");
    await tx.user.update({ where: { id: session.user.id }, data: {
      ...profile, ...(emailChanged ? { apiFeverKey: null, apiTokenVersion: { increment: 1 } } : {}),
    } });
    // Hashes cannot be recomputed without the original secret. Rotate after email changes.
    if (emailChanged) await tx.apiToken.updateMany({ where: { userId: session.user.id }, data: { feverKey: null } });
    return emailChanged;
    });
  } catch (error) {
    // Lost a race against another account taking the same address.
    if (isUniqueViolation(error)) return { success: false, code: "emailTaken" };
    throw error;
  }

  let emailNotice: "sent" | "failed" | "unavailable" | undefined;
  if (emailChanged && current.email && typeof profile.email === "string") {
    const { isMailServiceEnabled, sendEmailChangeNotices } = await import("@/lib/mail");
    if (!(await isMailServiceEnabled())) emailNotice = "unavailable";
    else {
      emailNotice = (await sendEmailChangeNotices({ oldEmail: current.email, newEmail: profile.email, locale: current.uiLanguage }).catch(() => false))
        ? "sent"
        : "failed";
    }
  }

  revalidatePath("/");
  return { success: true, emailChanged, feverRotationRequired: emailChanged, ...(emailNotice ? { emailNotice } : {}) };
}

export async function changePassword(data: {
  currentPassword: string;
  newPassword: string;
}): Promise<{ success: boolean; error?: string }> {
  const session = await requireUser();
  const { getTranslations } = await import("next-intl/server");
  const user = await db.user.findUnique({
    where: { id: session.user.id },
    select: { password: true, uiLanguage: true },
  });
  const t = await getTranslations({ locale: user?.uiLanguage ?? "en", namespace: "profile" });

  const parsed = ChangePasswordSchema.safeParse(data);
  if (!parsed.success) return { success: false, error: parsed.error.issues[0]?.message ?? t("passwordChangeFailed") };

  // Accounts provisioned via SSO/OAuth (e.g. Authelia) have no password set.
  if (!user?.password) return { success: false, error: t("noPasswordSet") };

  const currentMatches = await bcrypt.compare(parsed.data.currentPassword, user.password);
  if (!currentMatches) return { success: false, error: t("currentPasswordIncorrect") };

  const hashedPassword = await bcrypt.hash(parsed.data.newPassword, 10);
  await db.user.update({
    where: { id: session.user.id },
    // Keep the independent API password; revoke issued GReader Auth/T tokens.
    data: { password: hashedPassword, sessionVersion: { increment: 1 }, apiTokenVersion: { increment: 1 } },
  });

  return { success: true };
}

export async function getReadingPreferences() {
  const session = await requireUser();
  return loadReadingPreferences(session.user.id);
}

const GLOBAL_SETTINGS_TYPES = {
  defaultUpdateFrequency: "number",
  defaultRetentionDays: "number",
  openOriginalByDefault: "boolean",
  markReadAfterDelaySecs: "number",
  defaultViewMode: "string",
  readerWidth: "string",
  readerFontSize: "string",
  defaultArticleSort: "string",
  accentColor: "string",
  secondaryColor: "string",
  hideDuplicates: "boolean",
  markReadOnScroll: "boolean",
  markReadOnAdvance: "boolean",
  storyClustering: "boolean",
  clusterReadMode: "string",
  layoutDirection: "string",
  hideEmptyFeeds: "boolean",
  hideEmptyLabels: "boolean",
  countDisplay: "string",
  autoMuteFailingFeedsAfter: "number",
} as const;
const GLOBAL_SETTINGS_FIELDS = Object.keys(GLOBAL_SETTINGS_TYPES) as (keyof typeof GLOBAL_SETTINGS_TYPES)[];

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
  markReadOnAdvance?: boolean;
  storyClustering?: boolean;
  clusterReadMode?: "story" | "article";
  layoutDirection?: "ltr" | "rtl";
  hideEmptyFeeds?: boolean;
  hideEmptyLabels?: boolean;
  countDisplay?: CountDisplay;
  autoMuteFailingFeedsAfter?: number;
}) {
  const session = await requireUser();

  // Server actions receive arbitrary client JSON at runtime — the TypeScript type
  // above is not enforced. Only copy explicitly allowed preference fields; never
  // spread `data` into the update (that allowed setting role, email, passwordHash…).
  const updateData: Record<string, unknown> = {};
  const input = (data ?? {}) as Record<string, unknown>;
  for (const key of GLOBAL_SETTINGS_FIELDS) {
    if (input[key] !== undefined) updateData[key] = input[key];
  }
  for (const [key, type] of Object.entries(GLOBAL_SETTINGS_TYPES)) {
    const value = updateData[key];
    if (value === undefined || value === null) continue;
    if (typeof value !== type) throw new Error(`Invalid ${key}`);
  }
  if (data.autoMuteFailingFeedsAfter !== undefined) {
    // 0 = disabled/opt-out; otherwise clamp to a sane range.
    updateData.autoMuteFailingFeedsAfter =
      data.autoMuteFailingFeedsAfter <= 0 ? 0 : Math.min(1000, Math.round(data.autoMuteFailingFeedsAfter));
  }

  if (data.clusterReadMode !== undefined && data.clusterReadMode !== "story" && data.clusterReadMode !== "article") {
    throw new Error("Invalid clusterReadMode");
  }
  if (data.countDisplay !== undefined && !isCountDisplay(data.countDisplay)) {
    throw new Error("Invalid countDisplay");
  }

  await db.user.update({
    where: { id: session.user.id },
    data: updateData,
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
      twoFactorLastAcceptedStep: null,
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
    data: { twoFactorEnabled: true, sessionVersion: { increment: 1 }, apiTokenVersion: { increment: 1 } },
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
      apiTokenVersion: { increment: 1 },
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
      digestTimezone: true,
      digestScope: true,
      digestFeedIds: true,
      digestMaxArticles: true,
      digestMinArticles: true,
      digestLookbackHours: true,
      digestGroupByFeed: true,
      digestAiSummary: true,
      digestSkipFeatured: true,
      digestLabelIds: true,
      digestPausedUntil: true,
      digestLastSentAt: true,
      aiProvider: true,
      aiApiKey: true,
    },
  });

  const aiConfigured = !!user?.aiProvider && (user.aiProvider === "ollama" || !!user.aiApiKey);

  return {
    digestEnabled: user?.digestEnabled ?? false,
    digestFrequency: user?.digestFrequency ?? "daily",
    digestDayOfWeek: user?.digestDayOfWeek ?? 1,
    digestHour: user?.digestHour ?? 8,
    digestTimezone: user?.digestTimezone ?? "UTC",
    digestScope: user?.digestScope ?? "unread",
    digestFeedIds: user?.digestFeedIds ? (JSON.parse(user.digestFeedIds) as string[]) : [],
    digestLabelIds: user?.digestLabelIds ? (JSON.parse(user.digestLabelIds) as string[]) : [],
    digestMaxArticles: user?.digestMaxArticles ?? 20,
    digestMinArticles: user?.digestMinArticles ?? 1,
    digestLookbackHours: user?.digestLookbackHours ?? null,
    digestGroupByFeed: user?.digestGroupByFeed ?? false,
    digestAiSummary: user?.digestAiSummary ?? "none",
    digestSkipFeatured: user?.digestSkipFeatured ?? false,
    digestPausedUntil: user?.digestPausedUntil ?? null,
    digestLastSentAt: user?.digestLastSentAt ?? null,
    aiConfigured,
  };
}

export async function updateDigestSettings(data: {
  digestEnabled?: boolean;
  digestFrequency?: string;
  digestDayOfWeek?: number;
  digestHour?: number;
  digestTimezone?: string;
  digestScope?: string;
  digestFeedIds?: string[];
  digestLabelIds?: string[];
  digestMaxArticles?: number;
  digestMinArticles?: number;
  digestLookbackHours?: number | null;
  digestGroupByFeed?: boolean;
  digestAiSummary?: string;
  digestSkipFeatured?: boolean;
  digestPausedUntil?: Date | null;
}) {
  const session = await requireUser();

  // Allowlist: never spread untrusted server-action input into a user update.
  const updateData: Record<string, unknown> = pickFields(data, [
    "digestEnabled", "digestFrequency", "digestDayOfWeek", "digestHour", "digestTimezone", "digestScope",
    "digestFeedIds", "digestLabelIds", "digestMaxArticles", "digestMinArticles", "digestLookbackHours",
    "digestGroupByFeed", "digestAiSummary", "digestSkipFeatured", "digestPausedUntil",
  ] as const);
  if (data.digestFeedIds !== undefined && !Array.isArray(data.digestFeedIds)) throw new Error("Invalid digestFeedIds");
  if (data.digestLabelIds !== undefined && !Array.isArray(data.digestLabelIds)) throw new Error("Invalid digestLabelIds");

  if (data.digestFeedIds !== undefined) {
    updateData.digestFeedIds =
      data.digestFeedIds.length > 0 ? JSON.stringify(data.digestFeedIds) : null;
  }
  if (data.digestLabelIds !== undefined) {
    updateData.digestLabelIds =
      data.digestLabelIds.length > 0 ? JSON.stringify(data.digestLabelIds) : null;
  }

  if (data.digestMaxArticles !== undefined) {
    updateData.digestMaxArticles = Math.max(1, Math.min(100, data.digestMaxArticles));
  }
  if (data.digestMinArticles !== undefined) {
    updateData.digestMinArticles = Math.max(1, Math.min(50, data.digestMinArticles));
  }
  if (data.digestLookbackHours !== undefined) {
    updateData.digestLookbackHours =
      data.digestLookbackHours === null
        ? null
        : Math.max(1, Math.min(24 * 60, data.digestLookbackHours));
  }
  if (data.digestAiSummary !== undefined) {
    const allowed = new Set(["none", "per_feed", "full"]);
    if (!allowed.has(data.digestAiSummary)) {
      updateData.digestAiSummary = "none";
    }
  }
  if (data.digestFrequency !== undefined) {
    const allowed = new Set(["daily", "weekly", "weekdays"]);
    if (!allowed.has(data.digestFrequency)) {
      delete updateData.digestFrequency;
    }
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

export async function previewDigest() {
  const session = await requireUser();

  const user = await db.user.findUnique({
    where: { id: session.user.id },
    select: {
      digestScope: true,
      digestFeedIds: true,
      digestLabelIds: true,
      digestMaxArticles: true,
      digestMinArticles: true,
      digestLookbackHours: true,
      digestLastSentAt: true,
      digestFrequency: true,
      digestSkipFeatured: true,
    },
  });

  if (!user) throw new Error("Unauthorized");

  const feedIds: string[] | null = user.digestFeedIds ? JSON.parse(user.digestFeedIds) : null;
  const labelIds: string[] | null = user.digestLabelIds ? JSON.parse(user.digestLabelIds) : null;

  const lookbackHours = user.digestLookbackHours;
  let since: Date;
  if (lookbackHours && lookbackHours > 0) {
    since = new Date(Date.now() - lookbackHours * 60 * 60 * 1000);
  } else if (user.digestLastSentAt) {
    since = user.digestLastSentAt;
  } else {
    const fallback = user.digestFrequency === "weekly" ? 7 * 24 : 24;
    since = new Date(Date.now() - fallback * 60 * 60 * 1000);
  }

  const articles = await getDigestArticles(
    session.user.id,
    user.digestScope,
    feedIds,
    since,
    user.digestMaxArticles,
    { skipFeatured: user.digestSkipFeatured, labelIds },
  );

  const feedBreakdown = Object.values(
    articles.reduce<Record<string, { feedName: string; count: number }>>((acc, a) => {
      if (!acc[a.feedId]) acc[a.feedId] = { feedName: a.feedName, count: 0 };
      acc[a.feedId].count++;
      return acc;
    }, {}),
  ).sort((a, b) => b.count - a.count);

  return {
    articleCount: articles.length,
    wouldSend: articles.length >= Math.max(1, user.digestMinArticles),
    feedBreakdown,
    since,
  };
}

async function buildAiSummariesForTest(
  user: {
    aiProvider: string | null;
    aiApiKey: string | null;
    aiModel: string | null;
    aiOllamaBaseUrl: string | null;
    aiSummaryLanguage: string;
    digestAiSummary: string;
  },
  articles: Awaited<ReturnType<typeof getDigestArticles>>,
): Promise<{ overallSummary: string | null; feedSummaries: Record<string, string>; aiSubject: string | null }> {
  const provider = user.aiProvider as AiProvider | null;
  const decryptedKey = decryptIfValue(user.aiApiKey);
  const aiUsable = !!provider && (provider === "ollama" || !!decryptedKey);

  if (!aiUsable || user.digestAiSummary === "none" || articles.length === 0) {
    return { overallSummary: null, feedSummaries: {}, aiSubject: null };
  }

  const { generateDigestSummary, generateDigestSubject } = await import("@/lib/ai-summary");
  const aiConfig = {
    provider: provider!,
    apiKey: decryptedKey,
    model: user.aiModel,
    ollamaBaseUrl: user.aiOllamaBaseUrl,
    language: user.aiSummaryLanguage,
  };

  let overallSummary: string | null = null;
  const feedSummaries: Record<string, string> = {};
  let aiSubject: string | null = null;

  try {
    if (user.digestAiSummary === "full") {
      overallSummary = await generateDigestSummary(
        articles.map((a) => ({ title: a.title, excerpt: a.excerpt, feedName: a.feedName })),
        "full",
        aiConfig,
      ) || null;
    } else if (user.digestAiSummary === "per_feed") {
      const grouped = new Map<string, typeof articles>();
      for (const a of articles) {
        if (!grouped.has(a.feedId)) grouped.set(a.feedId, []);
        grouped.get(a.feedId)!.push(a);
      }
      for (const [feedId, group] of grouped) {
        if (group.length < 2) continue;
        try {
          feedSummaries[feedId] = await generateDigestSummary(
            group.map((a) => ({ title: a.title, excerpt: a.excerpt, feedName: a.feedName })),
            "per_feed",
            aiConfig,
          );
        } catch { /* ignore */ }
      }
    }
    aiSubject = await generateDigestSubject(
      articles.map((a) => ({ title: a.title, excerpt: a.excerpt, feedName: a.feedName })),
      aiConfig,
    ) || null;
  } catch { /* ignore */ }

  return { overallSummary, feedSummaries, aiSubject };
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
      digestLabelIds: true,
      digestMaxArticles: true,
      digestLookbackHours: true,
      digestGroupByFeed: true,
      digestAiSummary: true,
      digestSkipFeatured: true,
      digestUnsubscribeToken: true,
      aiProvider: true,
      aiApiKey: true,
      aiModel: true,
      aiOllamaBaseUrl: true,
      aiSummaryLanguage: true,
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
  const labelIds: string[] | null = user.digestLabelIds ? JSON.parse(user.digestLabelIds) : null;
  const lookbackHours = user.digestLookbackHours ?? 7 * 24;
  const since = new Date(Date.now() - lookbackHours * 60 * 60 * 1000);
  const articles = await getDigestArticles(
    session.user.id,
    user.digestScope,
    feedIds,
    since,
    user.digestMaxArticles,
    { skipFeatured: user.digestSkipFeatured, labelIds },
  );
  const baseUrl = process.env.AUTH_URL?.replace(/\/$/, "") ?? "http://localhost:3000";
  const unsubscribeUrl = `${baseUrl}/api/digest/unsubscribe?token=${token}`;

  const { overallSummary, feedSummaries, aiSubject } = await buildAiSummariesForTest(user, articles);

  await sendDigestEmail({
    to: user.email,
    userName: user.name,
    articles,
    unsubscribeToken: token,
    baseUrl,
    groupByFeed: user.digestGroupByFeed,
    overallSummary,
    feedSummaries,
    aiSubject,
    unsubscribeUrl,
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
      aiAutoTag: true,
      aiCleanTitles: true,
      briefingAuto: true,
    },
  });
  const { usageSummary } = await import("@/lib/ai/usage");
  const { isFakeAiEnabled } = await import("@/lib/ai/fake");
  const usage = await usageSummary(session.user.id);
  return {
    provider: user?.aiProvider ?? null,
    hasApiKey: !!user?.aiApiKey,
    model: user?.aiModel ?? null,
    ollamaBaseUrl: user?.aiOllamaBaseUrl ?? null,
    autoSummarize: user?.aiAutoSummarize ?? false,
    language: user?.aiSummaryLanguage ?? "same",
    autoTag: user?.aiAutoTag ?? false,
    cleanTitles: user?.aiCleanTitles ?? false,
    // K2: briefing auto-generation + daily token cap (null = server default).
    briefingAuto: user?.briefingAuto ?? true,
    dailyCap: usage.userCap,
    defaultDailyCap: usage.defaultCap,
    usedToday: usage.usedToday,
    /** Local (Ollama) tokens today — shown separately, never capped. */
    localUsedToday: usage.localToday,
    /** A cloud call was refused today: automatic AI features pause until `budgetResetsAt` (00:00 UTC). */
    budgetPaused: usage.paused,
    budgetResetsAt: usage.resetsAt,
    /** The deterministic CI provider is offered only behind its test gate. */
    fakeProviderAvailable: isFakeAiEnabled(),
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
  autoTag?: boolean;
  cleanTitles?: boolean;
  briefingAuto?: boolean;
  /** Daily token cap: null/"" = server default, 0 = AI off. */
  dailyCap?: number | string | null;
}) {
  const session = await requireUser();
  const updateData: Record<string, unknown> = {};
  if ("provider" in data) {
    const { isSelectableAiProvider } = await import("@/lib/ai-summary");
    if (data.provider !== null && data.provider !== undefined && !isSelectableAiProvider(data.provider)) {
      throw new Error("Unknown AI provider");
    }
    updateData.aiProvider = data.provider ?? null;
  }
  if ("briefingAuto" in data) updateData.briefingAuto = data.briefingAuto === true;
  let capChanged = false;
  if ("dailyCap" in data) {
    const { normalizeCapInput } = await import("@/lib/ai/usage");
    updateData.aiDailyTokenCap = normalizeCapInput(data.dailyCap);
    capChanged = true;
  }
  if (data.clearApiKey) {
    updateData.aiApiKey = null;
  } else if (data.apiKey) {
    updateData.aiApiKey = encryptIfValue(data.apiKey);
  }
  if ("model" in data) updateData.aiModel = data.model;
  if ("ollamaBaseUrl" in data) updateData.aiOllamaBaseUrl = data.ollamaBaseUrl;
  if ("autoSummarize" in data) updateData.aiAutoSummarize = data.autoSummarize;
  if ("language" in data) updateData.aiSummaryLanguage = data.language;
  if ("autoTag" in data) updateData.aiAutoTag = data.autoTag;
  if ("cleanTitles" in data) updateData.aiCleanTitles = data.cleanTitles === true;
  const before = capChanged ? await db.user.findUnique({ where: { id: session.user.id }, select: { aiDailyTokenCap: true } }) : null;
  await db.user.update({ where: { id: session.user.id }, data: updateData });
  if (capChanged && before?.aiDailyTokenCap !== updateData.aiDailyTokenCap) {
    // A new cap lifts today's "paused" note; the next refusal sets it again.
    const { clearBudgetPause } = await import("@/lib/ai/usage");
    await clearBudgetPause(session.user.id);
  }
  revalidatePath("/settings");
}

// AI provider errors come back as "{Provider} {status}: {truncated raw body}"
// (see lib/ai-summary.ts) — fine for logs, but a raw truncated JSON blob is
// meaningless to a non-technical admin clicking "Test connection". Map the
// common cases to a short, actionable sentence instead.
type TAiTestError = (key: string, params?: Record<string, string>) => string;

function humanizeAiTestError(message: string, t: TAiTestError): string {
  const statusMatch = message.match(/^(\w+)\s+(\d{3}):/);
  const provider = statusMatch?.[1];
  const status = statusMatch?.[2];
  if (status === "401" || status === "403" || /invalid.api.key|incorrect api key|unauthorized/i.test(message)) {
    return provider ? t("testErrorInvalidApiKeyWithProvider", { provider }) : t("testErrorInvalidApiKey");
  }
  if (status === "429" || /rate.?limit/i.test(message)) {
    return provider ? t("testErrorRateLimitedWithProvider", { provider }) : t("testErrorRateLimited");
  }
  if (status === "404") {
    return provider ? t("testErrorNotFoundWithProvider", { provider }) : t("testErrorNotFound");
  }
  if (/timed out|aborted|ETIMEDOUT|ECONNREFUSED/i.test(message)) {
    return t("testErrorUnreachable");
  }
  if (statusMatch && status) {
    return t("testErrorGenericHttp", { provider: provider ?? "", status });
  }
  return message.length > 150 ? `${message.slice(0, 150)}…` : message;
}

export async function testAiConnection(overrides?: {
  provider?: string | null;
  apiKey?: string;
  model?: string | null;
  ollamaBaseUrl?: string | null;
}): Promise<{ success: boolean; error?: string }> {
  const session = await requireUser();
  const user = await db.user.findUnique({
    where: { id: session.user.id },
    select: { aiProvider: true, aiApiKey: true, aiModel: true, aiOllamaBaseUrl: true, uiLanguage: true },
  });
  const { getTranslations } = await import("next-intl/server");
  const t = await getTranslations({ locale: user?.uiLanguage ?? "en", namespace: "ai" });

  // Test the form's current (possibly unsaved) values, not just what's
  // persisted — otherwise "Test connection" silently tests stale settings
  // until the user separately clicks "Save" first.
  const provider = overrides && "provider" in overrides ? overrides.provider : user?.aiProvider;
  const apiKey = overrides?.apiKey || decryptIfValue(user?.aiApiKey);
  const model = overrides && "model" in overrides ? overrides.model : user?.aiModel;
  const ollamaBaseUrl = overrides && "ollamaBaseUrl" in overrides ? overrides.ollamaBaseUrl : user?.aiOllamaBaseUrl;

  if (!provider) return { success: false, error: t("testErrorNoProvider") };
  try {
    const { generateSummary } = await import("@/lib/ai-summary");
    await generateSummary("Short test content for connectivity verification.", {
      provider: provider as AiProvider,
      apiKey,
      model: model ?? null,
      ollamaBaseUrl: ollamaBaseUrl ?? null,
    });
    return { success: true };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { success: false, error: humanizeAiTestError(message, t) };
  }
}

// ─── Hosted-fetch BYOK connector (M7-T3) ─────────────────────────────────────
//
// The last-resort heavy-fetch tier: a user's own API key for a commercial
// "URL to clean content" service (Jina Reader / Firecrawl Cloud). Per-user,
// opt-in, same BYOK pattern as the AI settings above. Unlike every earlier
// fetch tier, content leaves the user's own server — labelled accordingly in
// the settings UI, and never used during unattended background sync unless
// the user explicitly enables `autoUse`.

export async function getContentFetchSettings() {
  const session = await requireUser();
  const user = await db.user.findUnique({
    where: { id: session.user.id },
    select: { contentFetchProvider: true, contentFetchApiKey: true, contentFetchAutoUse: true },
  });
  return {
    provider: user?.contentFetchProvider ?? null,
    // Firecrawl alone is meaningful with hasApiKey:false — that's its keyless
    // free tier, not "not configured yet" (see getHostedFetchConfigForUser).
    hasApiKey: !!user?.contentFetchApiKey,
    autoUse: user?.contentFetchAutoUse ?? false,
  };
}

export async function updateContentFetchSettings(data: {
  provider?: string | null;
  apiKey?: string | null;
  clearApiKey?: boolean;
  autoUse?: boolean;
}) {
  const session = await requireUser();
  const updateData: Record<string, unknown> = {};
  if ("provider" in data) updateData.contentFetchProvider = data.provider;
  if (data.clearApiKey) {
    updateData.contentFetchApiKey = null;
  } else if (data.apiKey) {
    updateData.contentFetchApiKey = encryptIfValue(data.apiKey);
  }
  if ("autoUse" in data) updateData.contentFetchAutoUse = data.autoUse;
  await db.user.update({ where: { id: session.user.id }, data: updateData });
  revalidatePath("/settings");
}

export async function testContentFetchConnection(overrides?: {
  provider?: string | null;
  apiKey?: string;
}): Promise<{ success: boolean; error?: string; rateLimited?: boolean }> {
  const session = await requireUser();
  const user = await db.user.findUnique({
    where: { id: session.user.id },
    select: { contentFetchProvider: true, contentFetchApiKey: true, uiLanguage: true },
  });
  const { getTranslations } = await import("next-intl/server");
  const t = await getTranslations({ locale: user?.uiLanguage ?? "en", namespace: "contentFetch" });

  // Test the form's current (possibly unsaved) values, not just what's
  // persisted — otherwise "Test connection" silently tests stale settings
  // until the user separately clicks "Save" first.
  const provider = overrides && "provider" in overrides ? overrides.provider : user?.contentFetchProvider;
  const apiKey = overrides?.apiKey || decryptIfValue(user?.contentFetchApiKey);

  if (!provider) return { success: false, error: t("testErrorNoProvider") };
  const isKeylessFirecrawl = !apiKey && provider === "firecrawl";
  if (!apiKey && !isKeylessFirecrawl) return { success: false, error: t("testErrorNoApiKey") };
  const outcome = await fetchViaHostedApiDetailed("https://example.com/", {
    provider: provider as HostedFetchProvider,
    apiKey: apiKey || null,
  });
  if (!outcome.ok) {
    if (outcome.rateLimited) {
      return {
        success: false,
        rateLimited: true,
        error: isKeylessFirecrawl ? t("testErrorKeylessRateLimited") : t("testErrorRateLimited"),
      };
    }
    return { success: false, error: t("testErrorNoUsableContent") };
  }
  return { success: true };
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
      uiLanguage: true,
    },
  });

  const {
    sendTelegramNotification,
    sendGotifyNotification,
    sendNtfyNotification,
  } = await import("@/lib/notification-channels");

  const { getTranslations } = await import("next-intl/server");
  const tPush = await getTranslations({ locale: user?.uiLanguage ?? "en", namespace: "push" });
  const testPayload = {
    title: tPush("testTitle"),
    body: tPush("testBody"),
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

export async function getNotificationChannelStatus() {
  const session = await auth();
  if (!session?.user?.id) return { push: false, email: false, telegram: false, gotify: false, ntfy: false };
  const [user, settings, pushCount] = await Promise.all([
    db.user.findUnique({
      where: { id: session.user.id },
      select: {
        telegramEnabled: true, telegramBotToken: true, telegramChatId: true,
        gotifyEnabled: true, gotifyUrl: true, gotifyToken: true,
        ntfyEnabled: true, ntfyUrl: true, ntfyToken: true,
      },
    }),
    db.globalSettings.findUnique({ where: { id: "global" }, select: { mailServiceEnabled: true } }),
    db.pushSubscription.count({ where: { userId: session.user.id } }),
  ]);
  return {
    push: pushCount > 0,
    email: settings?.mailServiceEnabled ?? false,
    telegram: !!(user?.telegramEnabled && user.telegramBotToken && user.telegramChatId),
    gotify: !!(user?.gotifyEnabled && user.gotifyUrl && user.gotifyToken),
    ntfy: !!(user?.ntfyEnabled && user.ntfyUrl),
  };
}
