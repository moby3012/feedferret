"use server";

import { auth } from "@/auth";
import { db } from "@/lib/db";
import { getConfiguredMailProviders, sendTestSystemEmail, type MailProviderId } from "@/lib/mail";
import { encryptIfValue, decryptIfValue } from "@/lib/crypto";
import { revalidatePath } from "next/cache";

async function checkAdmin() {
  const session = await auth();
  if (session?.user?.role !== "ADMIN") {
    throw new Error("Unauthorized: Admin access required");
  }
  return session;
}

// Sensitive fields stored encrypted in the DB
const ENCRYPTED_FIELDS = [
  "smtpPassword",
  "resendApiKey",
  "postmarkServerToken",
  "mailgunApiKey",
  "sendgridApiKey",
] as const;

type EncryptedField = (typeof ENCRYPTED_FIELDS)[number];

function sanitizeSettingsInput(data: Record<string, unknown>) {
  const next: Record<string, unknown> = {};

  if (typeof data.registrationsEnabled === "boolean") next.registrationsEnabled = data.registrationsEnabled;
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

  // Misc
  if ("totpIssuer" in data) next.totpIssuer = String(data.totpIssuer || "").trim() || null;
  if (typeof data.backgroundSyncEnabled === "boolean") next.backgroundSyncEnabled = data.backgroundSyncEnabled;
  if (typeof data.allowInternalFeedUrls === "boolean") next.allowInternalFeedUrls = data.allowInternalFeedUrls;
  if ("backgroundSyncIntervalMinutes" in data) {
    const v = Number(data.backgroundSyncIntervalMinutes);
    next.backgroundSyncIntervalMinutes = Number.isFinite(v) && v > 0 ? v : 5;
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
  await checkAdmin();
  await db.user.update({
    where: { id: userId },
    data: { role },
  });
  revalidatePath("/");
}

export async function suspendUser(userId: string) {
  await checkAdmin();
  await db.user.update({ where: { id: userId }, data: { isActive: false } });
  revalidatePath("/");
}

export async function unsuspendUser(userId: string) {
  await checkAdmin();
  await db.user.update({ where: { id: userId }, data: { isActive: true } });
  revalidatePath("/");
}

export async function deleteUser(userId: string) {
  const session = await checkAdmin();
  if (session.user.id === userId) {
    throw new Error("Cannot delete your own account");
  }
  await db.user.delete({ where: { id: userId } });
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

  try {
    await sendTestSystemEmail(session.user.email, {
      ...testSettings,
      mailServiceEnabled: true,
      mailProvider: provider,
    });
    return { success: true, sentTo: session.user.email };
  } catch (error: any) {
    console.error("Mail provider test failed:", error);
    return { success: false, error: error?.message || "Unknown mail error" };
  }
}
