import nodemailer from "nodemailer";
import type { GlobalSettings } from "@prisma/client";
import { db } from "@/lib/db";
import { decryptIfValue } from "@/lib/crypto";
import { createEmailTranslator } from "@/lib/email-i18n";
import { writeSystemLog } from "@/lib/system-log";

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
    envManaged: false,
    description: "Transactional email via Resend API.",
  },
  postmark: {
    id: "postmark",
    label: "Postmark",
    envManaged: false,
    description: "Transactional email via Postmark API.",
  },
  mailgun: {
    id: "mailgun",
    label: "Mailgun",
    envManaged: false,
    description: "Transactional email via Mailgun API.",
  },
  sendgrid: {
    id: "sendgrid",
    label: "SendGrid",
    envManaged: false,
    description: "Transactional email via SendGrid API.",
  },
};

// Resolve effective API key: DB (decrypted) takes priority, ENV is fallback
function resolveKey(dbValue: string | null | undefined, envValue: string | undefined): string | undefined {
  const decrypted = decryptIfValue(dbValue);
  return decrypted || envValue || undefined;
}

function hasResend(s?: Partial<GlobalSettings> | null): boolean {
  return !!(resolveKey(s?.resendApiKey, process.env.RESEND_API_KEY) &&
    (s?.resendFromEmail || process.env.RESEND_FROM_EMAIL));
}

function hasPostmark(s?: Partial<GlobalSettings> | null): boolean {
  return !!(resolveKey(s?.postmarkServerToken, process.env.POSTMARK_SERVER_TOKEN) &&
    (s?.postmarkFromEmail || process.env.POSTMARK_FROM_EMAIL));
}

function hasMailgun(s?: Partial<GlobalSettings> | null): boolean {
  return !!(resolveKey(s?.mailgunApiKey, process.env.MAILGUN_API_KEY) &&
    (s?.mailgunDomain || process.env.MAILGUN_DOMAIN) &&
    (s?.mailgunFromEmail || process.env.MAILGUN_FROM_EMAIL));
}

function hasSendgrid(s?: Partial<GlobalSettings> | null): boolean {
  return !!(resolveKey(s?.sendgridApiKey, process.env.SENDGRID_API_KEY) &&
    (s?.sendgridFromEmail || process.env.SENDGRID_FROM_EMAIL));
}

export async function getConfiguredMailProviders(
  storedSettings?: Partial<GlobalSettings> | null,
): Promise<MailProviderOption[]> {
  const s = storedSettings ?? (await db.globalSettings.findUnique({ where: { id: "global" } }));
  const options: MailProviderOption[] = [PROVIDER_OPTIONS.smtp];
  if (hasResend(s)) options.push(PROVIDER_OPTIONS.resend);
  if (hasPostmark(s)) options.push(PROVIDER_OPTIONS.postmark);
  if (hasMailgun(s)) options.push(PROVIDER_OPTIONS.mailgun);
  if (hasSendgrid(s)) options.push(PROVIDER_OPTIONS.sendgrid);
  return options;
}

function isProviderAvailable(provider: MailProviderId, s?: Partial<GlobalSettings> | null): boolean {
  if (provider === "smtp") return true;
  if (provider === "resend") return hasResend(s);
  if (provider === "postmark") return hasPostmark(s);
  if (provider === "mailgun") return hasMailgun(s);
  if (provider === "sendgrid") return hasSendgrid(s);
  return false;
}

async function getStoredSettings(): Promise<GlobalSettings | null> {
  return db.globalSettings.findUnique({ where: { id: "global" } });
}

function resolveProvider(settings?: Partial<GlobalSettings> | null): MailProviderId {
  const provider = (settings?.mailProvider || "smtp") as MailProviderId;
  return isProviderAvailable(provider, settings) ? provider : "smtp";
}

function resolveFromAddress(
  provider: MailProviderId,
  settings?: Partial<GlobalSettings> | null,
): string {
  if (provider === "smtp") return settings?.smtpFrom || "noreply@localhost";
  if (provider === "resend") return settings?.resendFromEmail || process.env.RESEND_FROM_EMAIL!;
  if (provider === "postmark") return settings?.postmarkFromEmail || process.env.POSTMARK_FROM_EMAIL!;
  if (provider === "mailgun") return settings?.mailgunFromEmail || process.env.MAILGUN_FROM_EMAIL!;
  return settings?.sendgridFromEmail || process.env.SENDGRID_FROM_EMAIL!;
}

async function assertMailEnabled(settings?: Partial<GlobalSettings> | null) {
  if (!settings?.mailServiceEnabled) {
    throw new Error("Mail service is disabled");
  }
}

function resolveSmtpTransportOptions(
  port: number,
  secureMode: string | null | undefined,
  rejectUnauthorized: boolean | null | undefined,
): { secure: boolean; requireTLS?: boolean; tls?: { rejectUnauthorized: boolean } } {
  let secure: boolean;
  let requireTLS: boolean | undefined;

  switch (secureMode) {
    case "ssl":
      secure = true;
      break;
    case "starttls":
      secure = false;
      requireTLS = true;
      break;
    case "plain":
      secure = false;
      requireTLS = false;
      break;
    default:
      secure = port === 465;
  }

  return {
    secure,
    ...(requireTLS !== undefined ? { requireTLS } : {}),
    ...(rejectUnauthorized === false ? { tls: { rejectUnauthorized: false } } : {}),
  };
}

async function sendWithSmtp({
  settings,
  to,
  subject,
  html,
  text,
  extraHeaders,
}: {
  settings: Pick<GlobalSettings, "smtpHost" | "smtpPort" | "smtpUser" | "smtpPassword" | "smtpFrom" | "smtpSecure" | "smtpRejectUnauthorized">;
  to: string;
  subject: string;
  html: string;
  text: string;
  extraHeaders?: Record<string, string>;
}) {
  if (!settings.smtpHost || !settings.smtpPort || !settings.smtpFrom) {
    throw new Error("SMTP is not fully configured");
  }

  const smtpPassword = decryptIfValue(settings.smtpPassword);
  const tlsOpts = resolveSmtpTransportOptions(settings.smtpPort, settings.smtpSecure, settings.smtpRejectUnauthorized);
  const transporter = nodemailer.createTransport({
    host: settings.smtpHost,
    port: settings.smtpPort,
    ...tlsOpts,
    auth:
      settings.smtpUser && smtpPassword
        ? { user: settings.smtpUser, pass: smtpPassword }
        : undefined,
  });

  await transporter.sendMail({
    from: settings.smtpFrom,
    to,
    subject,
    html,
    text,
    ...(extraHeaders ? { headers: extraHeaders } : {}),
  });
}

async function sendWithResend({
  to,
  subject,
  html,
  text,
  from,
  apiKey,
  extraHeaders,
}: {
  to: string;
  subject: string;
  html: string;
  text: string;
  from: string;
  apiKey: string;
  extraHeaders?: Record<string, string>;
}) {
  const response = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ from, to: [to], subject, html, text, headers: extraHeaders }),
  });

  if (!response.ok) {
    throw new Error(`Resend error: ${await response.text()}`);
  }
}

async function sendWithPostmark({
  to,
  subject,
  html,
  text,
  from,
  token,
  messageStream,
  extraHeaders,
}: {
  to: string;
  subject: string;
  html: string;
  text: string;
  from: string;
  token: string;
  messageStream?: string;
  extraHeaders?: Record<string, string>;
}) {
  const headers = extraHeaders
    ? Object.entries(extraHeaders).map(([Name, Value]) => ({ Name, Value }))
    : undefined;
  const response = await fetch("https://api.postmarkapp.com/email", {
    method: "POST",
    headers: {
      Accept: "application/json",
      "Content-Type": "application/json",
      "X-Postmark-Server-Token": token,
    },
    body: JSON.stringify({
      From: from,
      To: to,
      Subject: subject,
      HtmlBody: html,
      TextBody: text,
      MessageStream: messageStream || process.env.POSTMARK_MESSAGE_STREAM || "outbound",
      ...(headers ? { Headers: headers } : {}),
    }),
  });

  if (!response.ok) {
    throw new Error(`Postmark error: ${await response.text()}`);
  }
}

async function sendWithMailgun({
  to,
  subject,
  html,
  text,
  from,
  apiKey,
  domain,
  baseUrl,
  extraHeaders,
}: {
  to: string;
  subject: string;
  html: string;
  text: string;
  from: string;
  apiKey: string;
  domain: string;
  baseUrl?: string;
  extraHeaders?: Record<string, string>;
}) {
  const url = `${baseUrl || process.env.MAILGUN_BASE_URL || "https://api.mailgun.net"}/v3/${domain}/messages`;
  const body = new URLSearchParams({ from, to, subject, html, text });
  if (extraHeaders) {
    for (const [k, v] of Object.entries(extraHeaders)) {
      body.append(`h:${k}`, v);
    }
  }

  const response = await fetch(url, {
    method: "POST",
    headers: {
      Authorization: `Basic ${Buffer.from(`api:${apiKey}`).toString("base64")}`,
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body,
  });

  if (!response.ok) {
    throw new Error(`Mailgun error: ${await response.text()}`);
  }
}

async function sendWithSendgrid({
  to,
  subject,
  html,
  text,
  from,
  apiKey,
  extraHeaders,
}: {
  to: string;
  subject: string;
  html: string;
  text: string;
  from: string;
  apiKey: string;
  extraHeaders?: Record<string, string>;
}) {
  const response = await fetch("https://api.sendgrid.com/v3/mail/send", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
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
      ...(extraHeaders ? { headers: extraHeaders } : {}),
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
  extraHeaders,
}: {
  to: string;
  subject: string;
  html: string;
  text: string;
  overrideSettings?: Partial<GlobalSettings> | null;
  extraHeaders?: Record<string, string>;
}) {
  const storedSettings = await getStoredSettings();
  const settings = { ...storedSettings, ...overrideSettings } as GlobalSettings | null;

  await assertMailEnabled(settings);

  const provider = resolveProvider(settings);
  const from = resolveFromAddress(provider, settings);

  try {
    if (provider === "smtp") {
      await sendWithSmtp({ settings: settings as GlobalSettings, to, subject, html, text, extraHeaders });
    } else if (provider === "resend") {
      const apiKey = resolveKey(settings?.resendApiKey, process.env.RESEND_API_KEY)!;
      await sendWithResend({ to, subject, html, text, from, apiKey, extraHeaders });
    } else if (provider === "postmark") {
      const token = resolveKey(settings?.postmarkServerToken, process.env.POSTMARK_SERVER_TOKEN)!;
      await sendWithPostmark({
        to,
        subject,
        html,
        text,
        from,
        token,
        messageStream: settings?.postmarkMessageStream || undefined,
        extraHeaders,
      });
    } else if (provider === "mailgun") {
      const apiKey = resolveKey(settings?.mailgunApiKey, process.env.MAILGUN_API_KEY)!;
      const domain = settings?.mailgunDomain || process.env.MAILGUN_DOMAIN!;
      await sendWithMailgun({
        to,
        subject,
        html,
        text,
        from,
        apiKey,
        domain,
        baseUrl: settings?.mailgunBaseUrl || undefined,
        extraHeaders,
      });
    } else {
      // sendgrid
      const apiKey = resolveKey(settings?.sendgridApiKey, process.env.SENDGRID_API_KEY)!;
      await sendWithSendgrid({ to, subject, html, text, from, apiKey, extraHeaders });
    }
    await writeSystemLog("info", "mail", "Email sent", { to, subject, provider });
  } catch (error: any) {
    await writeSystemLog("error", "mail", error?.message ?? String(error), { to, subject, provider });
    throw error;
  }
}

export async function sendSignInEmail({ email, url, locale }: { email: string; url: string; locale?: string }) {
  const t = createEmailTranslator(locale ?? "en");
  const { host } = new URL(url);
  await sendSystemEmail({
    to: email,
    subject: t("emailAuth.signInSubject", { host }),
    text: `${t("emailAuth.signInSubject", { host })}\n${url}\n\n`,
    html: `
      <div style="background:#f9f9f9;padding:20px;font-family:sans-serif;">
        <div style="max-width:600px;margin:0 auto;background:white;padding:40px;border-radius:10px;box-shadow:0 4px 6px rgba(0,0,0,0.05);">
          <h1 style="color:#111;margin-bottom:20px;">${t("emailAuth.signInSubject", { host })}</h1>
          <p style="color:#444;font-size:16px;line-height:1.6;">${t("emailAuth.signInBody")}</p>
          <a href="${url}" style="display:inline-block;background:#000;color:#fff;padding:12px 30px;border-radius:6px;text-decoration:none;font-weight:bold;margin-top:20px;">${t("emailAuth.signInButton")}</a>
          <hr style="border:none;border-top:1px solid #eee;margin:30px 0;" />
          <p style="color:#888;font-size:12px;">${t("emailAuth.signInIgnore")}</p>
        </div>
      </div>
    `,
  });
}

export async function sendTestSystemEmail(
  to: string,
  overrideSettings?: Partial<GlobalSettings> | null,
  locale = "en",
) {
  const t = createEmailTranslator(locale);
  const body = t("emailAuth.testBody");
  await sendSystemEmail({
    to,
    subject: t("emailAuth.testSubject"),
    text: body,
    html: `<b>${body}</b>`,
    overrideSettings,
  });
}
