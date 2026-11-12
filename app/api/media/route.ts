import { resolveSessionUser } from "@/lib/api-auth";
import { checkRateLimit, rateLimitResponse } from "@/lib/rate-limit";
import { getClientIpKey } from "@/lib/client-ip";
import { mediaProxyEnabled, verifyMediaSignature } from "@/lib/media-proxy";
import { canonicalMediaUrl } from "@/lib/media-url";
import { safeFetch } from "@/lib/ssrf";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const MAX_MEDIA_BYTES = 15 * 1024 * 1024;

export async function GET(request: Request) {
  const fail = (status: number) => new Response(null, { status, headers: { "Cache-Control": "no-store" } });
  const ipLimit = checkRateLimit(getClientIpKey(request), { prefix: "media-ip", limit: 600, windowSecs: 60 });
  if (!ipLimit.success) return rateLimitResponse(ipLimit);
  const sp = new URL(request.url).searchParams;
  const raw = sp.get("u") ?? "";
  if (raw.length > 8192 || !verifyMediaSignature(raw, sp.get("s") ?? "")) return fail(403);
  const user = await resolveSessionUser();
  if (!user) return fail(401);
  const limited = checkRateLimit(user.id, { prefix: "media-user", limit: 300, windowSecs: 60 });
  if (!limited.success) return rateLimitResponse(limited);
  if (!await mediaProxyEnabled(user.id)) return fail(403);

  // One deadline includes DNS, every redirect and the entire streamed body.
  const signal = AbortSignal.any([request.signal, AbortSignal.timeout(20_000)]);
  try {
    const upstream = await safeFetch(canonicalMediaUrl(raw)!, {
      signal, redirect: "manual", credentials: "omit",
      headers: { "User-Agent": "FeedFerret-Media/1.0", Accept: "image/*" },
    }, { allowInternal: false, followRedirects: true, maxRedirects: 5 });
    if (!upstream.ok || !upstream.body) {
      await upstream.body?.cancel();
      return fail(502);
    }
    const type = upstream.headers.get("content-type")?.split(";")[0].trim().toLowerCase() ?? "";
    if (!type.startsWith("image/") || type.includes("svg")) {
      await upstream.body.cancel();
      return fail(415);
    }
    if (Number(upstream.headers.get("content-length")) > MAX_MEDIA_BYTES) {
      await upstream.body.cancel();
      return fail(413);
    }
    let bytes = 0;
    const stream = upstream.body.pipeThrough(new TransformStream<Uint8Array, Uint8Array>({
      transform(chunk, controller) {
        bytes += chunk.byteLength;
        if (bytes > MAX_MEDIA_BYTES) throw new Error("Media size limit exceeded");
        controller.enqueue(chunk);
      },
    }));
    const headers = new Headers({
      "Content-Type": type,
      "Cache-Control": "public, max-age=604800, immutable",
      "X-Content-Type-Options": "nosniff",
      "Content-Security-Policy": "default-src 'none'",
      "Cross-Origin-Resource-Policy": "same-origin",
      "Referrer-Policy": "no-referrer",
    });
    for (const name of ["etag", "last-modified"]) {
      const value = upstream.headers.get(name);
      if (value) headers.set(name, value);
    }
    return new Response(stream, { headers });
  } catch { return fail(502); }
}
