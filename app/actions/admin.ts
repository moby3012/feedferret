"use server";

import { auth } from "@/auth";
import { db } from "@/lib/db";
import { getConfiguredMailProviders, sendTestSystemEmail, type MailProviderId } from "@/lib/mail";
import { revalidatePath } from "next/cache";

async function checkAdmin() {
  const session = await auth();
  if (session?.user?.role !== "ADMIN") {
    throw new Error("Unauthorized: Admin access required");
  }
  return session;
}

function sanitizeSettingsInput(data: Record<string, unknown>) {
  const next: Record<string, unknown> = {};

  if (typeof data.registrationsEnabled === "boolean") next.registrationsEnabled = data.registrationsEnabled;
  if (typeof data.mailServiceEnabled === "boolean") next.mailServiceEnabled = data.mailServiceEnabled;
  if (typeof data.mailProvider === "string") next.mailProvider = data.mailProvider;
  if ("smtpHost" in data) next.smtpHost = String(data.smtpHost || "").trim() || null;
  if ("smtpUser" in data) next.smtpUser = String(data.smtpUser || "").trim() || null;
  if ("smtpPassword" in data) next.smtpPassword = String(data.smtpPassword || "").trim() || null;
  if ("smtpFrom" in data) next.smtpFrom = String(data.smtpFrom || "").trim() || null;
  if ("smtpPort" in data) {
    const port = Number(data.smtpPort);
    next.smtpPort = Number.isFinite(port) && port > 0 ? port : null;
  }

  return next;
}

function assertMailProviderAllowed(provider: string) {
  const allowed = getConfiguredMailProviders().map((option) => option.id);
  if (!allowed.includes(provider as MailProviderId)) {
    throw new Error("Selected mail provider is not configured via environment variables");
  }
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

  const availableMailProviders = getConfiguredMailProviders();
  const allowedIds = availableMailProviders.map((option) => option.id);
  const normalizedMailProvider = allowedIds.includes(settings.mailProvider as MailProviderId)
    ? settings.mailProvider
    : "smtp";

  return {
    ...settings,
    mailProvider: normalizedMailProvider,
    availableMailProviders,
  };
}

export async function updateGlobalSettings(data: Record<string, unknown>) {
  await checkAdmin();
  const sanitized = sanitizeSettingsInput(data);

  if (typeof sanitized.mailProvider === "string") {
    assertMailProviderAllowed(sanitized.mailProvider);
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

  const sanitized = sanitizeSettingsInput(config);
  const provider = String(sanitized.mailProvider || "smtp");
  assertMailProviderAllowed(provider);

  try {
    await sendTestSystemEmail(session.user.email, {
      ...(sanitized as any),
      mailServiceEnabled: true,
      mailProvider: provider,
    });
    return { success: true, sentTo: session.user.email };
  } catch (error: any) {
    console.error("Mail provider test failed:", error);
    return { success: false, error: error?.message || "Unknown mail error" };
  }
}
