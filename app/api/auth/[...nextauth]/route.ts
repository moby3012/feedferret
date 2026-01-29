import { handlers } from "@/auth";
import { NextRequest } from "next/server";

export const GET = (req: NextRequest) => handlers.GET(req);
export const POST = (req: NextRequest) => handlers.POST(req);

export const dynamic = "force-dynamic";
export const runtime = "nodejs";
