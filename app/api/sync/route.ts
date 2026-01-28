import { syncAllFeeds } from "@/lib/rss-sync";
import { NextResponse } from "next/server";

export async function GET(request: Request) {
    // Simple protection: only allow if an API key matches or simple secret
    // For now, we'll just allow it for testing, but in production this needs a secret.
    const authHeader = request.headers.get("authorization");
    if (process.env.SYNC_SECRET && authHeader !== `Bearer ${process.env.SYNC_SECRET}`) {
        return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    try {
        const results = await syncAllFeeds();
        return NextResponse.json({ success: true, results });
    } catch (error) {
        return NextResponse.json({ error: String(error) }, { status: 500 });
    }
}
