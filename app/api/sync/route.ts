export const dynamic = "force-dynamic";

import { syncAllFeeds } from "@/lib/rss-sync";
import { NextResponse } from "next/server";

// Background sync state to prevent concurrent syncs
let lastSyncTime = 0;
let isSyncing = false;

export async function GET(request: Request) {
    const authHeader = request.headers.get("authorization");
    
    // Check SYNC_SECRET if configured
    if (process.env.SYNC_SECRET) {
        if (!authHeader || authHeader !== `Bearer ${process.env.SYNC_SECRET}`) {
            return NextResponse.json({ error: "Unauthorized - configure SYNC_SECRET env var" }, { status: 401 });
        }
    }

    // Prevent concurrent syncs (run at most every 2 minutes)
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
        
        const results = await syncAllFeeds();
        const synced = results.filter(r => r.success).length;
        
        return NextResponse.json({ 
            success: true, 
            synced,
            total: results.length,
            results: results.map(r => ({ feed: r.feed, success: r.success, count: r.count }))
        });
    } catch (error) {
        return NextResponse.json({ error: String(error) }, { status: 500 });
    } finally {
        isSyncing = false;
    }
}

// Auto-sync trigger - call this from client to trigger background sync
export async function POST(request: Request) {
    // Same auth check
    const authHeader = request.headers.get("authorization");
    if (process.env.SYNC_SECRET) {
        if (!authHeader || authHeader !== `Bearer ${process.env.SYNC_SECRET}`) {
            return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
        }
    }

    // Don't wait for sync to complete - trigger and return immediately
    // The actual sync runs in background
    setTimeout(async () => {
        try {
            isSyncing = true;
            lastSyncTime = Date.now();
            await syncAllFeeds();
        } catch (error) {
            console.error("Background sync failed:", error);
        } finally {
            isSyncing = false;
        }
    }, 100);

    return NextResponse.json({ 
        status: "scheduled", 
        message: "Background sync scheduled" 
    });
}
