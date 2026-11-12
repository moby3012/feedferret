import { resolveSessionUser } from "@/lib/api-auth";
import { checkRateLimit, rateLimitResponse } from "@/lib/rate-limit";
import { getClientIpKey } from "@/lib/client-ip";
import { mediaProxyEnabled, verifyMediaSignature } from "@/lib/media-proxy";
import { canonicalMediaUrl } from "@/lib/media-url";
import { mediaType, matchesMediaMagic } from "@/lib/media-type";
import { mediaTransfers } from "@/lib/media-limits";
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

  const transfer = mediaTransfers.acquire(user.id);
  if ("status" in transfer) return fail(transfer.status);
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
  let streaming = false;
  const stop = () => {
    transfer.release();
    void reader?.cancel().catch(() => undefined);
  };
  // One deadline includes DNS, every redirect and the entire streamed body.
  const signal = AbortSignal.any([request.signal, AbortSignal.timeout(20_000)]);
  signal.addEventListener("abort", stop, { once: true });
  try {
    const upstream = await safeFetch(canonicalMediaUrl(raw)!, {
      signal, redirect: "manual", credentials: "omit",
      headers: { "User-Agent": "FeedFerret-Media/1.0", Accept: "image/*" },
    }, { allowInternal: false, followRedirects: true, maxRedirects: 5 });
    if (!upstream.ok || !upstream.body) {
      await upstream.body?.cancel();
      return fail(502);
    }
    const type = mediaType(upstream.headers.get("content-type"));
    if (!type) {
      await upstream.body.cancel();
      return fail(415);
    }
    if (Number(upstream.headers.get("content-length")) > MAX_MEDIA_BYTES) {
      await upstream.body.cancel();
      return fail(413);
    }
    reader = upstream.body.getReader();
    let bytes = 0;
    const charge = (chunk: Uint8Array) => {
      bytes += chunk.byteLength;
      const allowed = transfer.charge(chunk.byteLength);
      if (bytes > MAX_MEDIA_BYTES) return 413;
      return allowed ? 0 : 429;
    };
    const prefix = new Uint8Array(32);
    let prefixSize = 0;
    const initial: Uint8Array[] = [];
    let ended = false;
    while (prefixSize < prefix.length) {
      const next = await reader.read();
      if (next.done) { ended = true; break; }
      const status = charge(next.value);
      if (status) return fail(status);
      initial.push(next.value);
      const part = next.value.subarray(0, prefix.length - prefixSize);
      prefix.set(part, prefixSize);
      prefixSize += part.length;
    }
    if (!matchesMediaMagic(type, prefix.subarray(0, prefixSize))) return fail(415);
    const finish = () => {
      transfer.release();
      signal.removeEventListener("abort", stop);
    };
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        for (const chunk of initial) controller.enqueue(chunk);
        if (ended) { controller.close(); finish(); }
      },
      async pull(controller) {
        try {
          const next = await reader!.read();
          if (next.done) { controller.close(); finish(); return; }
          const status = charge(next.value);
          if (status) throw new Error(status === 413 ? "Media size limit exceeded" : "Media byte budget exceeded");
          controller.enqueue(next.value);
        } catch (error) {
          controller.error(error);
          stop();
          finish();
        }
      },
      cancel() { stop(); finish(); },
    });
    const headers = new Headers({
      "Content-Type": type,
      "Cache-Control": "private, max-age=604800, immutable",
      "X-Content-Type-Options": "nosniff",
      "Content-Security-Policy": "default-src 'none'; sandbox",
      "Cross-Origin-Resource-Policy": "same-origin",
      "Referrer-Policy": "no-referrer",
    });
    for (const name of ["etag", "last-modified"]) {
      const value = upstream.headers.get(name);
      if (value) headers.set(name, value);
    }
    streaming = true;
    return new Response(stream, { headers });
  } catch { return fail(502); }
  finally {
    if (!streaming) { stop(); signal.removeEventListener("abort", stop); }
  }
}
