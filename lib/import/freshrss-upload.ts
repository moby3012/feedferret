/**
 * HTTP glue for the FreshRSS migration: bounded body read, per-user rate limit and
 * an instance-wide import slot (N9: one import at a time per instance, one per user;
 * a busy instance answers 429 before the body is read). Used by the session route
 * (`POST /api/import/freshrss`, the settings UI) and REST v1
 * (`POST /api/v1/import/freshrss`, API tokens).
 *
 * The body is the raw file (ZIP, OPML or article JSON), not multipart, so the size
 * cap is enforced while streaming instead of after the platform buffered it.
 */

import { NextResponse } from "next/server";
import { checkRateLimit, RATE_LIMITS, rateLimitHeaders, releaseRateLimit } from "@/lib/rate-limit";
import { FRESHRSS_UPLOAD_MAX_BYTES, MigrationInputError, runFreshRssMigration } from "./freshrss-migration";
import { revalidatePath } from "next/cache";
import { acquireImportSlot, ImportBusyError, importBusyResponse, type ReleaseImportSlot } from "./import-slots";

function fail(message: string, status: number, headers?: HeadersInit) {
  return NextResponse.json({ error: { message } }, { status, headers });
}

async function readBounded(request: Request, maxBytes: number): Promise<Buffer | NextResponse> {
  const declared = Number(request.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > maxBytes) return fail(`Upload too large (max ${Math.round(maxBytes / 1024 / 1024)} MB)`, 413);
  if (!request.body) return fail("Empty upload", 400);

  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel().catch(() => undefined);
      return fail(`Upload too large (max ${Math.round(maxBytes / 1024 / 1024)} MB)`, 413);
    }
    chunks.push(value);
  }
  if (total === 0) return fail("Empty upload", 400);
  return Buffer.concat(chunks, total);
}

export async function handleFreshRssUpload(request: Request, userId: string, options: { maxBytes?: number } = {}): Promise<Response> {
  const url = new URL(request.url);
  const dryRun = ["1", "true", "yes"].includes((url.searchParams.get("dryRun") ?? "").toLowerCase());

  const limited = checkRateLimit(`user:${userId}`, RATE_LIMITS.freshrssImport);
  if (!limited.success) return fail("Too many import attempts, try again later", 429, rateLimitHeaders(limited));

  let release: ReleaseImportSlot;
  try {
    release = await acquireImportSlot(userId);
  } catch (error) {
    if (!(error instanceof ImportBusyError)) throw error;
    // Nothing of the body was read; the client retries later. A refused attempt must not use
    // up the per-user budget, or retrying while another import runs locks the user out.
    releaseRateLimit(`user:${userId}`, RATE_LIMITS.freshrssImport);
    await request.body?.cancel().catch(() => undefined);
    return importBusyResponse(error);
  }
  try {
    const body = await readBounded(request, options.maxBytes ?? FRESHRSS_UPLOAD_MAX_BYTES);
    if (body instanceof NextResponse) return body;
    const report = await runFreshRssMigration(userId, body, { dryRun });
    if (!dryRun) {
      try { revalidatePath("/"); } catch { /* outside a Next request scope (tests) */ }
    }
    return NextResponse.json(report);
  } catch (error) {
    if (error instanceof MigrationInputError) return fail(error.message, error.status);
    throw error;
  } finally {
    release();
  }
}
