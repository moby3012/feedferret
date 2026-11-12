import { beforeEach, expect, it, vi } from "vitest";
vi.mock("@/lib/api-auth", () => ({ resolveSessionUser: vi.fn() }));
vi.mock("@/lib/media-proxy", () => ({ mediaProxyEnabled: vi.fn(), verifyMediaSignature: vi.fn() }));
vi.mock("@/lib/ssrf", () => ({ safeFetch: vi.fn() }));
import { GET, MAX_MEDIA_BYTES } from "@/app/api/media/route";
import { resolveSessionUser } from "@/lib/api-auth";
import { mediaProxyEnabled, verifyMediaSignature } from "@/lib/media-proxy";
import { safeFetch } from "@/lib/ssrf";
const png = Buffer.from("89504e470d0a1a0a000000000000000000000000000000000000000000000000", "hex");
let sequence = 0;
beforeEach(() => {
  vi.mocked(resolveSessionUser).mockResolvedValue({ id: `media-unit-${sequence++}` } as never);
  vi.mocked(mediaProxyEnabled).mockResolvedValue(true);
  vi.mocked(verifyMediaSignature).mockReturnValue(true);
});
const request = () => new Request("https://reader.example/api/media?u=https%3A%2F%2Fexample.org%2Fa&s=test", { headers: { Cookie: "private-cookie", Authorization: "private-token", Referer: "https://private.example" } });
it("rejects invalid signatures and missing sessions before fetching", async () => {
  vi.mocked(verifyMediaSignature).mockReturnValue(false);
  expect((await GET(request())).status).toBe(403);
  vi.mocked(verifyMediaSignature).mockReturnValue(true);
  vi.mocked(mediaProxyEnabled).mockResolvedValue(false);
  expect((await GET(request())).status).toBe(403);
  vi.mocked(resolveSessionUser).mockResolvedValue(null);
  expect((await GET(request())).status).toBe(401);
});
it("streams with privacy headers and only anonymous upstream headers", async () => {
  vi.mocked(safeFetch).mockResolvedValue(new Response(png, { headers: { "content-type": "image/png", etag: '"v1"', "last-modified": "Wed, 01 Jan 2025 00:00:00 GMT", "set-cookie": "private" } }));
  const response = await GET(request());
  expect(new Uint8Array(await response.arrayBuffer())).toEqual(new Uint8Array(png));
  expect(response.headers.get("content-type")).toBe("image/png");
  expect(response.headers.get("cache-control")).toBe("private, max-age=604800, immutable");
  expect(response.headers.get("content-security-policy")).toBe("default-src 'none'; sandbox");
  expect(response.headers.get("cross-origin-resource-policy")).toBe("same-origin");
  expect(response.headers.get("x-content-type-options")).toBe("nosniff");
  expect(response.headers.get("etag")).toBe('"v1"');
  expect(response.headers.has("set-cookie")).toBe(false);
  const [, init, options] = vi.mocked(safeFetch).mock.lastCall!;
  expect(init?.headers).toEqual({ "User-Agent": "FeedFerret-Media/1.0", Accept: "image/*" });
  expect(options?.allowInternal).toBe(false);
});
it("refuses HTML, SVG and declared oversized images", async () => {
  for (const type of ["text/html", "image/svg+xml"]) {
    vi.mocked(safeFetch).mockResolvedValue(new Response("bad", { headers: { "content-type": type } }));
    expect((await GET(request())).status).toBe(415);
  }
  vi.mocked(safeFetch).mockResolvedValue(new Response("large", { headers: { "content-type": "image/png", "content-length": String(MAX_MEDIA_BYTES + 1) } }));
  expect((await GET(request())).status).toBe(413);
});
it("aborts an oversized chunked body without forwarding the excess", async () => {
  vi.mocked(safeFetch).mockResolvedValue(new Response(new ReadableStream({
    start(c) { const large = new Uint8Array(MAX_MEDIA_BYTES); large.set(png); c.enqueue(large); c.enqueue(new Uint8Array(1)); c.close(); },
  }), { headers: { "content-type": "image/png" } }));
  const response = await GET(request());
  await expect(response.arrayBuffer()).rejects.toThrow("Media size limit");
});

it("refuses ambiguous or duplicate MIME headers and mismatched magic bytes", async () => {
  const duplicate = new Headers();
  duplicate.append("content-type", "image/png");
  duplicate.append("content-type", "text/html");
  for (const headers of [duplicate, new Headers({ "content-type": "image/png, text/html" }), new Headers({ "content-type": "image/png; boundary=html" })]) {
    vi.mocked(safeFetch).mockResolvedValue(new Response(png, { headers }));
    expect((await GET(request())).status).toBe(415);
  }
  for (const type of ["image/png", "image/jpeg", "image/gif", "image/webp", "image/avif", "image/bmp", "image/x-icon"]) {
    vi.mocked(safeFetch).mockResolvedValue(new Response("<html><form>phishing</form></html>", { headers: { "content-type": type } }));
    expect((await GET(request())).status).toBe(415);
  }
});
it("normalizes MIME and accumulates split magic bytes before returning a response", async () => {
  vi.mocked(safeFetch).mockResolvedValue(new Response(new ReadableStream({
    start(c) { c.enqueue(png.subarray(0, 2)); c.enqueue(png.subarray(2)); c.close(); },
  }), { headers: { "content-type": 'Image/PNG; charset="utf-8"' } }));
  const result = await GET(request());
  expect(result.status).toBe(200);
  expect(result.headers.get("content-type")).toBe("image/png");
  expect(new Uint8Array(await result.arrayBuffer())).toEqual(new Uint8Array(png));
});
it("holds slots through streaming and releases them on cancellation", async () => {
  const { MediaTransferLimiter, mediaTransfers } = await import("@/lib/media-limits");
  const limits = new MediaTransferLimiter(() => 1000, 1, 1);
  const spy = vi.spyOn(mediaTransfers, "acquire").mockImplementation(id => limits.acquire(id));
  const cancel = vi.fn();
  try {
    vi.mocked(safeFetch).mockResolvedValue(new Response(new ReadableStream({
      start(c) { c.enqueue(png); }, cancel,
    }), { headers: { "content-type": "image/png" } }));
    const response = await GET(request());
    expect(response.status).toBe(200);
    expect((await GET(request())).status).toBe(429);
    await response.body!.cancel();
    expect(cancel).toHaveBeenCalledOnce();
    expect(limits.acquire("another")).not.toHaveProperty("status");
  } finally { spy.mockRestore(); }
});
it("charges prefix bytes, returns 429 before headers and aborts budget overruns in streams", async () => {
  const { MediaTransferLimiter, mediaTransfers } = await import("@/lib/media-limits");
  const limits = new MediaTransferLimiter(() => 64);
  const spy = vi.spyOn(mediaTransfers, "acquire").mockImplementation(id => limits.acquire(id));
  try {
    vi.mocked(safeFetch).mockResolvedValue(new Response(new Uint8Array(65), { headers: { "content-type": "image/png" } }));
    expect((await GET(request())).status).toBe(429);
    // beforeEach user id is stable within this test: the exhausted budget sticks.
    expect((await GET(request())).status).toBe(429);
    vi.mocked(resolveSessionUser).mockResolvedValue({ id: "stream-budget" } as never);
    vi.mocked(safeFetch).mockResolvedValue(new Response(new ReadableStream({
      start(c) { c.enqueue(png); c.enqueue(new Uint8Array(40)); c.close(); },
    }), { headers: { "content-type": "image/png" } }));
    const response = await GET(request());
    expect(response.status).toBe(200);
    await expect(response.arrayBuffer()).rejects.toThrow("Media byte budget");
  } finally { spy.mockRestore(); }
});
it.each(["request", "deadline"])("errors truncated streams on %s abort instead of closing them successfully", async source => {
  vi.useFakeTimers();
  const timeout = vi.spyOn(AbortSignal, "timeout").mockImplementation(ms => {
    const controller = new AbortController();
    setTimeout(() => controller.abort(new Error("expected deadline abort")), ms);
    return controller.signal;
  });
  try {
    const controller = new AbortController();
    const cancel = vi.fn();
    vi.mocked(safeFetch).mockResolvedValue(new Response(new ReadableStream({ start(c) { c.enqueue(png); }, cancel }), { headers: { "content-type": "image/png" } }));
    const response = await GET(new Request(request(), { signal: controller.signal }));
    expect(response.status).toBe(200);
    const failedBody = expect(response.arrayBuffer()).rejects.toThrow(source === "request" ? "expected request abort" : "expected deadline abort");
    if (source === "request") controller.abort(new Error("expected request abort"));
    else await vi.advanceTimersByTimeAsync(20_000);
    await failedBody;
    expect(cancel).toHaveBeenCalledOnce();
  } finally { timeout.mockRestore(); vi.useRealTimers(); }
});
it.each(["headers", "body"])("applies the first-byte deadline while waiting for %s", async stage => {
  vi.useFakeTimers();
  try {
    if (stage === "headers") {
      vi.mocked(safeFetch).mockImplementation((_url, init) => new Promise((_resolve, reject) => {
        init!.signal!.addEventListener("abort", () => reject(init!.signal!.reason), { once: true });
      }));
    } else {
      vi.mocked(safeFetch).mockResolvedValue(new Response(new ReadableStream({ start() {} }), { headers: { "content-type": "image/png" } }));
    }
    let settled = false;
    const pending = GET(request()).then(response => { settled = true; return response; });
    await vi.advanceTimersByTimeAsync(4999);
    expect(settled).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    const response = await pending;
    expect(response.status).toBe(502);
    expect(response.headers.get("cache-control")).toBe("no-store");
  } finally { vi.useRealTimers(); }
});
