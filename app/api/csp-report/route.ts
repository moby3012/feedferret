import { checkRateLimit, getClientIdentifier, rateLimitResponse } from "@/lib/rate-limit";
import { recordCspReports } from "@/lib/csp-reports";

const MAX_BYTES = 16 * 1024;

export async function POST(request: Request): Promise<Response> {
  const limit = checkRateLimit(getClientIdentifier(request), { prefix: "csp-report", limit: 30, windowSecs: 60 });
  if (!limit.success) return rateLimitResponse(limit);
  if (Number(request.headers.get("content-length")) > MAX_BYTES) return new Response(null, { status: 413 });
  const reader = request.body?.getReader();
  if (!reader) return new Response(null, { status: 400 });
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > MAX_BYTES) {
        await reader.cancel();
        return new Response(null, { status: 413 });
      }
      chunks.push(value);
    }
    const bytes = new Uint8Array(size);
    let offset = 0;
    for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
    recordCspReports(JSON.parse(new TextDecoder().decode(bytes)));
    return new Response(null, { status: 204 });
  } catch {
    return new Response(null, { status: 400 });
  } finally {
    reader.releaseLock();
  }
}
