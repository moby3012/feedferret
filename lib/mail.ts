import nodemailer from "nodemailer";
import type { GlobalSettings } from "@prisma/client";
import { db } from "@/lib/db";

export type MailProviderId = "smtp" | "resend" | "postmark" | "mailgun" | "sendgrid";

export interface MailProviderOption {
  id: MailProviderId;
  label: string;
  envManaged: boolean;
  description: string;
}

const PROVIDER_OPTIONS: Record<MailProviderId, MailProviderOption> = {
  smtp: {
    id: "smtp",
    label: "SMTP",
    envManaged: false,
    description: "Manual SMTP configuration in server settings.",
  },
  resend: {
    id: "resend",
    label: "Resend",
    envManaged: true,
    description: "Transactional email via Resend API.",
  },
  postmark: {
    id: "postmark",
    label: "Postmark",
    envManaged: true,
    description: "Transactional email via Postmark API.",
  },
  mailgun: {
    id: "mailgun",
    label: "Mailgun",
    envManaged: true,
    description: "Transactional email via Mailgun API.",
  },
  sendgrid: {
    id: "sendgrid",
    label: "SendGrid",
    envManaged: true,
    description: "Transactional email via SendGrid API.",
  },
};

function hasResendEnv() {
  return !!process.env.RESEND_API_KEY && !!process.env.RESEND_FROM_EMAIL;
}

function hasPostmarkEnv() {
  return !!process.env.POSTMARK_SERVER_TOKEN && !!process.env.POSTMARK_FROM_EMAIL;
}

function hasMailgunEnv() {
  return !!process.env.MAILGUN_API_KEY && !!process.env.MAILGUN_DOMAIN && !!process.env.MAILGUN_FROM_EMAIL;
}

function hasSendgridEnv() {
  return !!process.env.SENDGRID_API_KEY && !!process.env.SENDGRID_FROM_EMAIL;
}

export function getConfiguredMailProviders(): MailProviderOption[] {
  const options: MailProviderOption[] = [PROVIDER_OPTIONS.smtp];
  if (hasResendEnv()) options.push(PROVIDER_OPTIONS.resend);
  if (hasPostmarkEnv()) options.push(PROVIDER_OPTIONS.postmark);
  if (hasMailgunEnv()) options.push(PROVIDER_OPTIONS.mailgun);
  if (hasSendgridEnv()) options.push(PROVIDER_OPTIONS.sendgrid);
  return options;
}

function isProviderAvailable(provider: MailProviderId) {
  if (provider === "smtp") return true;
  return getConfiguredMailProviders().some((option) => option.id === provider);
}

async function getStoredSettings() {
  return db.globalSettings.findUnique({ where: { id: "global" } });
}

function resolveProvider(settings?: Pick<GlobalSettings, "mailProvider"> | null): MailProviderId {
  const provider = (settings?.mailProvider || "smtp") as MailProviderId;
  return isProviderAvailable(provider) ? provider : "smtp";
}

function resolveFromAddress(provider: MailProviderId, settings?: Pick<GlobalSettings, "smtpFrom"> | null) {
  if (provider === "smtp") return settings?.smtpFrom || "noreply@localhost";
  if (provider === "resend") return process.env.RESEND_FROM_EMAIL!;
  if (provider === "postmark") return process.env.POSTMARK_FROM_EMAIL!;
  if (provider === "mailgun") return process.env.MAILGUN_FROM_EMAIL!;
  return process.env.SENDGRID_FROM_EMAIL!;
}

async function assertMailEnabled(settings?: Pick<GlobalSettings, "mailServiceEnabled"> | null) {
  if (!settings?.mailServiceEnabled) {
    throw new Error("Mail service is disabled");
  }
}

async function sendWithSmtp({
  settings,
  to,
  subject,
  html,
  text,
}: {
  settings: Pick<GlobalSettings, "smtpHost" | "smtpPort" | "smtpUser" | "smtpPassword" | "smtpFrom">;
  to: string;
  subject: string;
  html: string;
  text: string;
}) {
  if (!settings.smtpHost || !settings.smtpPort || !settings.smtpFrom) {
    throw new Error("SMTP is not fully configured");
  }

  const transporter = nodemailer.createTransport({
    host: settings.smtpHost,
    port: settings.smtpPort,
    secure: settings.smtpPort === 465,
    auth:
      settings.smtpUser && settings.smtpPassword
        ? { user: settings.smtpUser, pass: settings.smtpPassword }
        : undefined,
  });

  await transporter.sendMail({
    from: settings.smtpFrom,
    to,
    subject,
    html,
    text,
  });
}

async function sendWithResend({ to, subject, html, text, from }: { to: string; subject: string; html: string; text: string; from: string }) {
  const response = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${process.env.RESEND_API_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ from, to: [to], subject, html, text }),
  });

  if (!response.ok) {
    throw new Error(`Resend error: ${await response.text()}`);
  }
}

async function sendWithPostmark({ to, subject, html, text, from }: { to: string; subject: string; html: string; text: string; from: string }) {
  const response = await fetch("https://api.postmarkapp.com/email", {
    method: "POST",
    headers: {
      Accept: "application/json",
      "Content-Type": "application/json",
      "X-Postmark-Server-Token": process.env.POSTMARK_SERVER_TOKEN!,
    },
    body: JSON.stringify({
      From: from,
      To: to,
      Subject: subject,
      HtmlBody: html,
      TextBody: text,
      MessageStream: process.env.POSTMARK_MESSAGE_STREAM || "outbound",
    }),
  });

  if (!response.ok) {
    throw new Error(`Postmark error: ${await response.text()}`);
  }
}

async function sendWithMailgun({ to, subject, html, text, from }: { to: string; subject: string; html: string; text: string; from: string }) {
  const baseUrl = process.env.MAILGUN_BASE_URL || "https://api.mailgun.net";
  const domain = process.env.MAILGUN_DOMAIN!;
  const body = new URLSearchParams({ from, to, subject, html, text });

  const response = await fetch(`${baseUrl}/v3/${domain}/messages`, {
    method: "POST",
    headers: {
      Authorization: `Basic ${Buffer.from(`api:${process.env.MAILGUN_API_KEY}`).toString("base64")}`,
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body,
  });

  if (!response.ok) {
    throw new Error(`Mailgun error: ${await response.text()}`);
  }
}

async function sendWithSendgrid({ to, subject, html, text, from }: { to: string; subject: string; html: string; text: string; from: string }) {
  const response = await fetch("https://api.sendgrid.com/v3/mail/send", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${process.env.SENDGRID_API_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      from: { email: from },
      personalizations: [{ to: [{ email: to }] }],
      subject,
      content: [
        { type: "text/plain", value: text },
        { type: "text/html", value: html },
      ],
    }),
  });

  if (!response.ok) {
    throw new Error(`SendGrid error: ${await response.text()}`);
  }
}

export async function sendSystemEmail({
  to,
  subject,
  html,
  text,
  overrideSettings,
}: {
  to: string;
  subject: string;
  html: string;
  text: string;
  overrideSettings?: Partial<GlobalSettings> | null;
}) {
  const storedSettings = await getStoredSettings();
  const settings = { ...storedSettings, ...overrideSettings } as GlobalSettings | null;

  await assertMailEnabled(settings);

  const provider = resolveProvider(settings);
  const from = resolveFromAddress(provider, settings);

  if (provider === "smtp") {
    await sendWithSmtp({ settings: settings as GlobalSettings, to, subject, html, text });
    return;
  }
  if (provider === "resend") {
    await sendWithResend({ to, subject, html, text, from });
    return;
  }
  if (provider === "postmark") {
    await sendWithPostmark({ to, subject, html, text, from });
    return;
  }
  if (provider === "mailgun") {
    await sendWithMailgun({ to, subject, html, text, from });
    return;
  }
  await sendWithSendgrid({ to, subject, html, text, from });
}

export async function sendSignInEmail({ email, url }: { email: string; url: string }) {
  const { host } = new URL(url);
  await sendSystemEmail({
    to: email,
    subject: `Sign in to ${host}`,
    text: `Sign in to ${host}\n${url}\n\n`,
    html: `
      <div style="background:#f9f9f9;padding:20px;font-family:sans-serif;">
        <div style="max-width:600px;margin:0 auto;background:white;padding:40px;border-radius:10px;box-shadow:0 4px 6px rgba(0,0,0,0.05);">
          <h1 style="color:#111;margin-bottom:20px;">Sign in to ${host}</h1>
          <p style="color:#444;font-size:16px;line-height:1.6;">Click the button below to sign in to your FeedFerret account. This link will expire in 24 hours.</p>
          <a href="${url}" style="display:inline-block;background:#000;color:#fff;padding:12px 30px;border-radius:6px;text-decoration:none;font-weight:bold;margin-top:20px;">Sign in</a>
          <hr style="border:none;border-top:1px solid #eee;margin:30px 0;" />
          <p style="color:#888;font-size:12px;">If you didn't request this email, you can safely ignore it.</p>
        </div>
      </div>
    `,
  });
}

export async function sendTestSystemEmail(to: string, overrideSettings?: Partial<GlobalSettings> | null) {
  await sendSystemEmail({
    to,
    subject: "FeedFerret mail provider test",
    text: "If you received this message, your FeedFerret email provider is configured correctly.",
    html: "<b>If you received this message, your FeedFerret email provider is configured correctly.</b>",
    overrideSettings,
  });
}
