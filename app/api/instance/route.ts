import { NextResponse } from "next/server";
import { db } from "@/lib/db";

export const dynamic = "force-dynamic";

export async function GET() {
  const settings = await db.globalSettings.findUnique({
    where: { id: "global" },
    select: {
      instanceName: true,
      instanceIconDataUrl: true,
      registrationsEnabled: true,
      mailServiceEnabled: true,
      smtpHost: true,
      mailProvider: true,
      sendgridApiKey: true,
      resendApiKey: true,
      mailgunApiKey: true,
      postmarkServerToken: true,
    },
  });

  const mailProvider = settings?.mailProvider || "smtp";
  const hasMailCredentials = (() => {
    if (!settings) return false;
    switch (mailProvider) {
      case "sendgrid": return Boolean(settings.sendgridApiKey);
      case "resend": return Boolean(settings.resendApiKey);
      case "mailgun": return Boolean(settings.mailgunApiKey);
      case "postmark": return Boolean(settings.postmarkServerToken);
      case "smtp":
      default: return Boolean(settings.smtpHost);
    }
  })();
  const mailConfigured = Boolean(settings?.mailServiceEnabled && hasMailCredentials);
  const pushConfigured = Boolean(
    process.env.WEB_PUSH_VAPID_PUBLIC_KEY &&
      process.env.WEB_PUSH_VAPID_PRIVATE_KEY &&
      process.env.WEB_PUSH_CONTACT,
  );

  return NextResponse.json({
    instanceName: settings?.instanceName || "FeedFerret",
    instanceIconDataUrl: settings?.instanceIconDataUrl || null,
    registrationsEnabled: settings?.registrationsEnabled ?? true,
    capabilities: {
      mail: mailConfigured,
      push: pushConfigured,
      magicLink: mailConfigured,
    },
  });
}
