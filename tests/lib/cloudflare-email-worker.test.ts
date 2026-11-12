// N1 PR C: the worker script the wizard hands out is executed here (Web Crypto,
// fetch mocked) and its request is verified by the server's own signature check,
// so template and endpoint cannot drift apart.
import { describe, expect, it, vi } from "vitest";
import { CLOUDFLARE_EMAIL_WORKER_TEMPLATE, renderCloudflareEmailWorker, WORKER_SECRET_PLACEHOLDER, WORKER_URL_PLACEHOLDER } from "@/lib/cloudflare-email-worker";
import { verifyInboundSignature } from "@/lib/inbound-email-webhook";

vi.mock("@/lib/db", () => ({ db: {} }));
vi.mock("@/lib/secret-box", () => ({ sealSecret: (_p: string, v: string) => v, readPlainColumnState: () => ({ value: null, unreadable: false }) }));
vi.mock("@/lib/newsletter-after-ingest", () => ({ afterIngest: vi.fn() }));
vi.mock("@/lib/inbound-email", () => ({ MAX_RAW_EMAIL_BYTES: 10 * 1024 * 1024, ingestRawEmail: vi.fn() }));

const URL_ = "https://feeds.example.org/api/webhooks/inbound-email/clxsource0001";
const SECRET = "ab".repeat(32);

type Worker = { email: (message: unknown, env: unknown, ctx: unknown) => Promise<void> };
function load(script: string): Worker {
  const body = script.replace("export default", "return");
  return new Function(body)() as Worker;
}

const rawStream = (text: string) => new ReadableStream<Uint8Array>({ start: (c) => (c.enqueue(new TextEncoder().encode(text)), c.close()) });
function message(over: Record<string, unknown> = {}) {
  const raw = "From: a@b.example\r\nTo: tok@news.example\r\nSubject: Grüße\r\n\r\nBody ✓";
  return { raw: rawStream(raw), rawSize: raw.length, to: "tok@news.example", setReject: vi.fn(), text: raw, ...over };
}

describe("renderCloudflareEmailWorker", () => {
  it("fills URL and secret and leaves no placeholder", () => {
    const script = renderCloudflareEmailWorker(URL_, SECRET);
    expect(script).toContain(`const WEBHOOK_URL = "${URL_}";`);
    expect(script).toContain(`const WEBHOOK_SECRET = "${SECRET}";`);
    expect(script).not.toContain(WORKER_URL_PLACEHOLDER);
    expect(script).not.toContain(WORKER_SECRET_PLACEHOLDER);
    expect(CLOUDFLARE_EMAIL_WORKER_TEMPLATE).toContain(WORKER_SECRET_PLACEHOLDER);
  });
  it("escapes hostile values as string literals and treats $ literally", () => {
    const script = renderCloudflareEmailWorker('https://x.example/"; process.exit(); "', "$&$1\\\"");
    expect(() => new Function(script.replace("export default", "return"))).not.toThrow();
    expect(script).not.toContain('"; process.exit(); "');
    expect(script).toContain(JSON.stringify("$&$1\\\""));
  });
  it("uses no template-literal syntax that String.raw could have mangled", () => {
    expect(CLOUDFLARE_EMAIL_WORKER_TEMPLATE).not.toContain("`");
    expect(CLOUDFLARE_EMAIL_WORKER_TEMPLATE).toContain('"\\n" + recipient + "\\n"');
  });
});

describe("the generated worker", () => {
  it("posts the raw mail with a signature the server accepts", async () => {
    const worker = load(renderCloudflareEmailWorker(URL_, SECRET));
    const fetchMock = vi.fn(async (_url: string, _init: RequestInit) => new Response("{}", { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    const msg = message();
    await worker.email(msg, {}, {});
    vi.unstubAllGlobals();

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe(URL_);
    expect(init.method).toBe("POST");
    const headers = init.headers as Record<string, string>;
    expect(headers["content-type"]).toBe("message/rfc822");
    expect(headers["x-feedferret-recipient"]).toBe("tok@news.example");
    const body = Buffer.from(init.body as ArrayBuffer);
    expect(body.toString("utf8")).toBe(msg.text);
    const common = { secret: SECRET, signatureHeader: headers["x-feedferret-signature"], timestampHeader: headers["x-feedferret-timestamp"], recipient: "tok@news.example" };
    expect(verifyInboundSignature({ ...common, body })).toBe("ok");
    expect(verifyInboundSignature({ ...common, body: Buffer.concat([body, Buffer.from("!")]) })).toBe("invalid");
    expect(verifyInboundSignature({ ...common, secret: "ff".repeat(32), body })).toBe("invalid");
    expect(msg.setReject).not.toHaveBeenCalled();
  });

  it("rejects oversized mail without calling the server", async () => {
    const worker = load(renderCloudflareEmailWorker(URL_, SECRET));
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const msg = message({ rawSize: 11 * 1024 * 1024 });
    await worker.email(msg, {}, {});
    vi.unstubAllGlobals();
    expect(msg.setReject).toHaveBeenCalledWith("Message too large");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it.each([401, 403, 404, 410, 413])("bounces permanently on HTTP %i", async (status) => {
    const worker = load(renderCloudflareEmailWorker(URL_, SECRET));
    vi.stubGlobal("fetch", vi.fn(async () => new Response("{}", { status })));
    const msg = message();
    await worker.email(msg, {}, {});
    vi.unstubAllGlobals();
    expect(msg.setReject).toHaveBeenCalledWith(expect.stringContaining(String(status)));
  });

  it.each([429, 500, 503])("throws (temporary failure) on HTTP %i", async (status) => {
    const worker = load(renderCloudflareEmailWorker(URL_, SECRET));
    vi.stubGlobal("fetch", vi.fn(async () => new Response("{}", { status })));
    const msg = message();
    await expect(worker.email(msg, {}, {})).rejects.toThrow(String(status));
    vi.unstubAllGlobals();
    expect(msg.setReject).not.toHaveBeenCalled();
  });
});
