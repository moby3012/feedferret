import { hasSyncSecret } from "@/lib/sync-auth";
export const dynamic = "force-dynamic";

import { auth } from "@/auth";
import { getBackgroundSyncStatus } from "@/lib/background-sync";
import { NextResponse } from "next/server";

export async function GET(request: Request) {
    const hasSecretAuth = hasSyncSecret(request);

    if (!hasSecretAuth) {
        const session = await auth();
        if (!session?.user?.id) {
            return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
        }
    }

    return NextResponse.json({
        backgroundSync: getBackgroundSyncStatus(),
        config: {
            disabled: process.env.DISABLE_BACKGROUND_SYNC === "true",
            intervalMinutes: Number(process.env.BACKGROUND_SYNC_INTERVAL_MINUTES) || 5,
        },
    });
}
