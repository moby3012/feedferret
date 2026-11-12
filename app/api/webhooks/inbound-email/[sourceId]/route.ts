// N1 PR C: inbound-email webhook. All logic (signature, replay window, size cap,
// rate limits, adapters, ingest) lives in lib/inbound-email-webhook.ts.
import { handleInboundEmailWebhook } from "@/lib/inbound-email-webhook";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function POST(request: Request, context: { params: Promise<{ sourceId: string }> }) {
  const { sourceId } = await context.params;
  return handleInboundEmailWebhook(request, sourceId);
}
