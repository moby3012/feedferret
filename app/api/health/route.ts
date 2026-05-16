import { db } from "@/lib/db";
import { NextResponse } from "next/server";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET() {
  let dbStatus: "ok" | "error" = "error";

  try {
    await db.$queryRaw`SELECT 1`;
    dbStatus = "ok";
  } catch {
    // db unreachable
  }

  const status = dbStatus === "ok" ? "ok" : "degraded";
  const httpStatus = status === "ok" ? 200 : 503;

  return NextResponse.json(
    {
      status,
      db: dbStatus,
      version: process.env.npm_package_version ?? "0.1.0",
      uptime: Math.floor(process.uptime()),
    },
    { status: httpStatus },
  );
}
