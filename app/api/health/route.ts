import { db } from "@/lib/db";
import { NextResponse } from "next/server";
import { htmlWorkerStatus } from "@/lib/html-worker/pool";

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

  // Untrusted HTML is parsed only in the worker pool (lib/html-worker), which
  // fails closed: without it full text, page feeds, newsletters and feed-item
  // sanitizing are off. Reported as degraded; the HTTP status stays tied to
  // the database so an orchestrator does not restart-loop a container that a
  // restart cannot fix.
  const htmlWorker = htmlWorkerStatus();
  const status = dbStatus === "ok" && htmlWorker !== "unavailable" ? "ok" : "degraded";
  const httpStatus = dbStatus === "ok" ? 200 : 503;

  return NextResponse.json(
    {
      status,
      db: dbStatus,
      htmlWorker,
      version: process.env.npm_package_version ?? "0.1.0",
      uptime: Math.floor(process.uptime()),
    },
    { status: httpStatus },
  );
}
