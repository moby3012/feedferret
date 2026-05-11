export const dynamic = "force-dynamic";

import { db } from "@/lib/db";
import { NextResponse } from "next/server";

/**
 * GET /api/digest/unsubscribe?token=<digestUnsubscribeToken>
 * One-click unsubscribe from email digests.
 * Linked from the footer of every digest email.
 * No auth required — the token itself is the credential.
 */
export async function GET(request: Request) {
    const { searchParams } = new URL(request.url);
    const token = searchParams.get("token");

    if (!token) {
        return new NextResponse("Missing token", { status: 400 });
    }

    const user = await db.user.findUnique({
        where: { digestUnsubscribeToken: token },
        select: { id: true, email: true },
    });

    if (!user) {
        return new NextResponse(
            `<!DOCTYPE html><html><body style="font-family:sans-serif;padding:40px;max-width:500px;margin:auto">
            <h2>Invalid unsubscribe link</h2>
            <p>This link is invalid or has already been used.</p>
            </body></html>`,
            { status: 400, headers: { "Content-Type": "text/html" } },
        );
    }

    await db.user.update({
        where: { id: user.id },
        data: { digestEnabled: false },
    });

    return new NextResponse(
        `<!DOCTYPE html><html><body style="font-family:sans-serif;padding:40px;max-width:500px;margin:auto;background:#f9fafb">
        <div style="background:#fff;padding:32px;border-radius:12px;box-shadow:0 1px 3px rgba(0,0,0,.1)">
          <h2 style="margin:0 0 12px">🦦 Unsubscribed</h2>
          <p style="color:#4b5563;margin:0">You have been successfully unsubscribed from FeedFerret email digests.</p>
          <p style="color:#6b7280;font-size:14px;margin:16px 0 0">
            You can re-enable digests at any time in <strong>Settings → Digest</strong>.
          </p>
        </div>
        </body></html>`,
        { status: 200, headers: { "Content-Type": "text/html" } },
    );
}
