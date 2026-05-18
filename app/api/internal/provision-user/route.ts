import { db } from "@/lib/db";
import { NextResponse } from "next/server";
import { validateInternalApiKey } from "@/lib/internal-auth";
import { sendSystemEmail } from "@/lib/mail";
import { checkRateLimit, getClientIdentifier, rateLimitResponse, RATE_LIMITS } from "@/lib/rate-limit";
import { logger } from "@/lib/logger";

export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  const rlResult = checkRateLimit(getClientIdentifier(request), RATE_LIMITS.internalApi);
  if (!rlResult.success) return rateLimitResponse(rlResult);

  if (!validateInternalApiKey(request)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  let body: { email?: string; name?: string } | null = null;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const email = body?.email?.trim().toLowerCase();
  if (!email) {
    return NextResponse.json({ error: "email is required" }, { status: 400 });
  }

  const existing = await db.user.findUnique({ where: { email } });
  if (existing) {
    return NextResponse.json(
      { error: "User already exists", userId: existing.id },
      { status: 409 },
    );
  }

  const user = await db.user.create({
    data: {
      email,
      name: body?.name?.trim() || null,
      role: "USER",
      isActive: true,
    },
  });

  // Send welcome email non-blocking — don't fail provisioning if mail is down
  sendWelcomeEmail(email, body?.name).catch((e) =>
    logger.error("[provision-user] welcome email failed:", e),
  );

  return NextResponse.json(
    { userId: user.id, email: user.email, created: true },
    { status: 201 },
  );
}

async function sendWelcomeEmail(email: string, name?: string | null) {
  const settings = await db.globalSettings.findUnique({ where: { id: "global" } });
  if (!settings?.mailServiceEnabled) return;

  const displayName = name?.trim() || "there";
  const instanceName = settings.instanceName || "FeedFerret";
  const instanceUrl = settings.instanceUrl || "";

  const loginLink = instanceUrl ? `${instanceUrl}/login` : null;
  const loginSection = loginLink
    ? `<a href="${loginLink}" style="display:inline-block;background:#000;color:#fff;padding:12px 30px;border-radius:6px;text-decoration:none;font-weight:bold;margin-top:20px;">Sign in to ${instanceName}</a>`
    : `<p style="color:#444;font-size:14px;">Visit your ${instanceName} instance and sign in using the magic link option.</p>`;

  await sendSystemEmail({
    to: email,
    subject: `Welcome to ${instanceName}`,
    text: `Hi ${displayName},\n\nYour ${instanceName} account is ready. Sign in using the magic link option on the login page with this email address.${loginLink ? `\n\n${loginLink}` : ""}\n\nEnjoy your feeds!`,
    html: `
      <div style="background:#f9f9f9;padding:20px;font-family:sans-serif;">
        <div style="max-width:600px;margin:0 auto;background:white;padding:40px;border-radius:10px;box-shadow:0 4px 6px rgba(0,0,0,0.05);">
          <h1 style="color:#111;margin-bottom:20px;">Welcome to ${instanceName}</h1>
          <p style="color:#444;font-size:16px;line-height:1.6;">Hi ${displayName},</p>
          <p style="color:#444;font-size:16px;line-height:1.6;">
            Your account is ready. Sign in using the <strong>magic link</strong> option on the login page with this email address.
          </p>
          ${loginSection}
          <hr style="border:none;border-top:1px solid #eee;margin:30px 0;" />
          <p style="color:#888;font-size:12px;">You received this email because an account was created for you. If this was unexpected, you can safely ignore it.</p>
        </div>
      </div>
    `,
  });
}
