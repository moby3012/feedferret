export const dynamic = "force-dynamic";

import { auth } from "@/auth";
import { db } from "@/lib/db";
import { NextResponse } from "next/server";
import { generateApiToken } from "@/lib/token";

/**
 * GET /api/user/token
 * Returns whether the authenticated user has an API token set.
 * Does NOT return the token value (use POST to generate and retrieve it).
 *
 * Auth: session cookie only
 *
 * Response 200: { hasToken: boolean }
 */
export async function GET() {
    const session = await auth();
    if (!session?.user?.id) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

    const user = await db.user.findUnique({
        where: { id: session.user.id },
        select: { apiToken: true },
    });

    return NextResponse.json({ hasToken: !!user?.apiToken });
}

/**
 * POST /api/user/token
 * Generate (or regenerate) the API token for the authenticated user.
 * Returns the new token — this is the ONLY time the raw token is returned.
 * Store it securely; it cannot be retrieved again (only revoked).
 *
 * Auth: session cookie only
 *
 * Response 200: { token: string }
 */
export async function POST() {
    const session = await auth();
    if (!session?.user?.id) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

    const { raw, hash } = generateApiToken();

    await db.user.update({
        where: { id: session.user.id },
        data: { apiToken: hash },
    });

    return NextResponse.json({ token: raw });
}

/**
 * DELETE /api/user/token
 * Revoke the API token for the authenticated user.
 * All existing integrations using this token will stop working immediately.
 *
 * Auth: session cookie only
 *
 * Response 200: { revoked: true }
 */
export async function DELETE() {
    const session = await auth();
    if (!session?.user?.id) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

    await db.user.update({
        where: { id: session.user.id },
        data: { apiToken: null },
    });

    return NextResponse.json({ revoked: true });
}
