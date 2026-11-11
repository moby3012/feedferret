export const dynamic = "force-dynamic";

import { auth } from "@/auth";
import { syncAllFeeds, syncUserFeeds } from "@/lib/rss-sync";
import { NextResponse } from "next/server";
import { hasSyncSecret } from "@/lib/sync-auth";
import { logger } from "@/lib/logger";

// Background sync state to prevent concurrent syncs
let lastSyncTime = 0;
let lastCronSyncTime = 0;
let isSyncing = false;

export async function GET(request: Request) {
    if (!hasSyncSecret(request)) return NextResponse.json({ error: "Not found" }, { status: 404 });

    // Prevent concurrent syncs (run at most every 2 minutes)
    const now = Date.now();
    if (isSyncing || (now - lastCronSyncTime) < 120000) {
        return NextResponse.json({ 
            status: "already_syncing", 
            message: "Sync already in progress",
            lastSync: new Date(lastCronSyncTime).toISOString()
        });
    }

    try {
        isSyncing = true;
        lastCronSyncTime = now;
        
        const results = await syncAllFeeds();
        const synced = results.filter(r => r.success && !r.skipped).length;
        
        return NextResponse.json({ 
            success: true, 
            synced,
            deferred: results.filter(r => "deferred" in r && r.deferred).length,
            total: results.length,
            results: results.map(r => ({ success: r.success, count: r.count }))
        });
    } catch (error) {
        logger.error("[sync/GET]", error);
        return NextResponse.json({ error: "Sync failed" }, { status: 500 });
    } finally {
        isSyncing = false;
    }
}

// Auto-sync trigger - call this from client to trigger background sync
export async function POST(request: Request) {
    const session = await auth();
    if (!session?.user?.id) {
        return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const now = Date.now();
    if (isSyncing && (now - lastSyncTime) < 120000) {
        return NextResponse.json({
            status: "already_syncing",
            message: "Sync already in progress",
            lastSync: new Date(lastSyncTime).toISOString()
        });
    }

    try {
        isSyncing = true;
        lastSyncTime = now;
        const results = await syncUserFeeds(session.user.id);
        const synced = results.filter(r => r.success && !r.skipped).length;

        return NextResponse.json({
            success: true,
            synced,
            total: results.length,
            results: results.map(r => ({ success: r.success, skipped: r.skipped, count: r.count }))
        });
    } catch (error) {
        logger.error("[sync/POST]", error);
        return NextResponse.json({ error: "Sync failed" }, { status: 500 });
    } finally {
        isSyncing = false;
    }
}
