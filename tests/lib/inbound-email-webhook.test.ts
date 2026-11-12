// N1 PR C: webhook signature (HMAC, replay window, constant-time), Basic fallback,
// capped body reading, and the request handler (source state, rate limits, ingest
// mapping, no secrets / bodies in logs). No network, no real DB.
import { beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => {
  const source = { id: "src_webhook_1", kind: "cloudflare", paused: false, webhookSecret: "ff2.sealed" as string | null };
  return {
    source,
    secret: "s3cr3t-".padEnd(64, "x"),
    db: { inboundMailSource: { findUnique: vi.fn(async (_args: unknown): Promise<typeof source | null> => source), update: vi.fn(async (_args: unknown) => ({})) } },
    ingest: vi.fn(async (_raw: unknown, _options: unknown): Promise<Record<string, unknown>> => ({ status: "created", userId: "u1", articleId: "a1" })),
    after: vi.fn(async () => undefined),
    logs: [] as string[],
  };
});

vi.mock("@/lib/db", () => ({ db: h.db }));
vi.mock("@/lib/secret-box", () => ({
  sealSecret: (_purpose: string, value: string) => `ff2.${value}`,
  readPlainColumnState: (_purpose: string, stored: string | null) => ({ value: stored ? h.secret : null, unreadable: false }),
}));
vi.mock("@/lib/inbound-email", () => ({ MAX_RAW_EMAIL_BYTES: 10 * 1024 * 1024, ingestRawEmail: h.ingest }));
vi.mock("@/lib/newsletter-after-ingest", () => ({ afterIngest: h.after }));
vi.mock("@/lib/logger", () => {
  const sink = (...args: unknown[]) => void h.logs.push(JSON.stringify(args));
  return { logger: { info: sink, warn: sink, error: sink, debug: sink } };
});

import { checkRateLimit, peekRateLimit, RATE_LIMITS } from "@/lib/rate-limit";
import {
  BodyTimeoutError,
  handleInboundEmailWebhook,
  inFlightWebhookRequests,
  MAX_CONCURRENT_WEBHOOK_REQUESTS,
  MAX_WEBHOOK_BODY_BYTES,
  readBodyCapped,
  SIGNATURE_TOLERANCE_SECS,
  signInboundBody,
  verifyBasicSecret,
  verifyInboundSignature,
} from "@/lib/inbound-email-webhook";

const SECRET = h.secret;
const MAIL = Buffer.from("From: a@b.example\r\nTo: tok@news.example\r\nSubject: Hello secret subject\r\n\r\nBODY-MARKER-1234");
const nowSecs = () => Math.floor(Date.now() / 1000);

let ipSeq = 0;
function request(init: { body?: Buffer | string; headers?: Record<string, string>; signed?: boolean; timestamp?: number; recipient?: string; ip?: string } = {}) {
  const body = init.body ?? MAIL;
  const timestamp = String(init.timestamp ?? nowSecs());
  const recipient = init.recipient ?? "tok@news.example";
  const headers: Record<string, string> = {
    "content-type": "message/rfc822",
    "x-forwarded-for": init.ip ?? `203.0.113.${(ipSeq = (ipSeq + 1) % 250)}`,
    ...(init.signed === false
      ? {}
      : {
          "x-feedferret-timestamp": timestamp,
          "x-feedferret-recipient": recipient,
          "x-feedferret-signature": `sha256=${signInboundBody(SECRET, timestamp, recipient, Buffer.from(body))}`,
        }),
    ...init.headers,
  };
  return new Request("http://localhost/api/webhooks/inbound-email/src_webhook_1", { method: "POST", headers, body: typeof body === "string" ? body : new Blob([Uint8Array.from(body)]) });
}

beforeEach(() => {
  vi.clearAllMocks();
  h.logs.length = 0;
  h.source.kind = "cloudflare";
  h.source.paused = false;
  h.source.webhookSecret = "ff2.sealed";
  h.db.inboundMailSource.findUnique.mockImplementation(async () => h.source);
  h.ingest.mockImplementation(async () => ({ status: "created", userId: "u1", articleId: "a1" }));
});

describe("verifyInboundSignature", () => {
  const sign = (ts: number, rcpt = "r@x.example", body = MAIL) => signInboundBody(SECRET, String(ts), rcpt, body);
  const check = (over: Partial<Parameters<typeof verifyInboundSignature>[0]> & { ts?: number }) => {
    const ts = over.ts ?? 1_700_000_000;
    return verifyInboundSignature({
      secret: SECRET,
      signatureHeader: `sha256=${sign(ts)}`,
      timestampHeader: String(ts),
      recipient: "r@x.example",
      body: MAIL,
      nowSecs: ts,
      ...over,
    });
  };

  it("accepts a valid signature, with or without the sha256= prefix", () => {
    expect(check({})).toBe("ok");
    expect(check({ signatureHeader: sign(1_700_000_000) })).toBe("ok");
    expect(check({ signatureHeader: `SHA256=${sign(1_700_000_000).toUpperCase()}` })).toBe("ok"); // hex and prefix are case-insensitive
  });

  it("rejects a wrong key, tampered body, tampered recipient or tampered timestamp", () => {
    expect(check({ secret: "another-secret" })).toBe("invalid");
    expect(check({ body: Buffer.concat([MAIL, Buffer.from("x")]) })).toBe("invalid");
    expect(check({ recipient: "other@x.example" })).toBe("invalid");
    expect(check({ timestampHeader: "1700000001" })).toBe("invalid");
  });

  it("rejects missing, malformed and wrong-length signatures without throwing", () => {
    for (const signatureHeader of [null, "", "sha256=", "sha256=zz", "abc", "sha256=" + "a".repeat(63), "sha256=" + "a".repeat(65), "sha1=" + sign(1_700_000_000)]) {
      expect(check({ signatureHeader })).toBe("invalid");
    }
    expect(check({ timestampHeader: null })).toBe("invalid");
    expect(check({ timestampHeader: "" })).toBe("invalid");
    expect(check({ timestampHeader: "1".repeat(30) })).toBe("invalid");
  });

  it("enforces the ±5 minute replay window, only for authentic requests", () => {
    const sent = 1_700_000_000;
    const at = (now: number, ts = sent) => check({ ts, nowSecs: now });
    expect(SIGNATURE_TOLERANCE_SECS).toBe(300);
    expect(at(sent + 300)).toBe("ok");
    expect(at(sent - 300)).toBe("ok");
    expect(at(sent + 301)).toBe("stale");
    expect(at(sent - 301)).toBe("stale");
    // A forged signature is "invalid" no matter how old the timestamp is.
    expect(check({ signatureHeader: "sha256=" + "0".repeat(64), nowSecs: sent + 10_000 })).toBe("invalid");
  });

  it("refuses a non-numeric timestamp even when the signature matches it", () => {
    const signature = signInboundBody(SECRET, "yesterday", "r@x.example", MAIL);
    expect(verifyInboundSignature({ secret: SECRET, signatureHeader: signature, timestampHeader: "yesterday", recipient: "r@x.example", body: MAIL })).toBe("stale");
  });
});

describe("verifyBasicSecret", () => {
  const basic = (user: string, pass: string) => `Basic ${Buffer.from(`${user}:${pass}`).toString("base64")}`;
  it("compares the password only, in any user name", () => {
    expect(verifyBasicSecret(basic("feedferret", SECRET), SECRET)).toBe(true);
    expect(verifyBasicSecret(basic("", SECRET), SECRET)).toBe(true);
    expect(verifyBasicSecret(basic("feedferret", SECRET + "x"), SECRET)).toBe(false);
    expect(verifyBasicSecret(basic("feedferret", ""), SECRET)).toBe(false);
    expect(verifyBasicSecret(basic("feedferret", SECRET.slice(1)), SECRET)).toBe(false);
  });
  it("rejects other schemes and garbage", () => {
    for (const header of [null, "", "Bearer abc", "Basic", "Basic !!!", `Basic ${"A".repeat(5000)}`]) {
      expect(verifyBasicSecret(header, SECRET)).toBe(false);
    }
  });
});

describe("readBodyCapped", () => {
  const post = (body: BodyInit | null, headers: Record<string, string> = {}) => new Request("http://x.example/", { method: "POST", body, headers });
  it("reads a body within the limit", async () => {
    expect((await readBodyCapped(post("hello"), 10))?.toString()).toBe("hello");
    expect((await readBodyCapped(post("1234567890"), 10))?.length).toBe(10);
    expect((await readBodyCapped(post(null), 10))?.length).toBe(0);
  });
  it("returns null when the body exceeds the limit, also without a Content-Length", async () => {
    expect(await readBodyCapped(post("12345678901"), 10)).toBeNull();
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        for (let i = 0; i < 5; i++) controller.enqueue(new Uint8Array(4));
        controller.close();
      },
    });
    const request = new Request("http://x.example/", { method: "POST", body: stream, duplex: "half" } as RequestInit);
    expect(request.headers.get("content-length")).toBeNull();
    expect(await readBodyCapped(request, 10)).toBeNull();
  });
  it("cuts off a body that stalls", async () => {
    const stalled = new ReadableStream<Uint8Array>({ start: (c) => c.enqueue(new Uint8Array(4)) });
    const request = new Request("http://x.example/", { method: "POST", body: stalled, duplex: "half" } as RequestInit);
    await expect(readBodyCapped(request, 1000, 40)).rejects.toBeInstanceOf(BodyTimeoutError);
  });
  it("trusts neither a lying nor a missing Content-Length", async () => {
    const declared = new Request("http://x.example/", { method: "POST", body: "tiny", headers: { "content-length": "999999999" } });
    expect(await readBodyCapped(declared, 1000)).toBeNull();
  });
});

describe("handleInboundEmailWebhook", () => {
  const call = (req: Request, id = "src_webhook_1") => handleInboundEmailWebhook(req, id);
  const json = async (res: Response) => (await res.json()) as Record<string, unknown>;

  it("stores a correctly signed raw mail through the shared ingest", async () => {
    const res = await call(request());
    expect(res.status).toBe(200);
    expect(await json(res)).toMatchObject({ ok: true, status: "created", format: "rfc822" });
    expect(h.ingest).toHaveBeenCalledTimes(1);
    const [raw, options] = h.ingest.mock.calls[0] as [Buffer, { recipients: string[] }];
    expect(Buffer.from(raw).equals(MAIL)).toBe(true);
    expect(options.recipients).toEqual(["tok@news.example"]);
    expect(h.after).toHaveBeenCalledWith([{ userId: "u1", articleId: "a1" }], "inbound-email-webhook");
    expect(h.db.inboundMailSource.update).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ errorCount: 0, lastError: null, lastReceivedAt: expect.any(Date) }) }));
  });

  it("answers 401 for a missing, wrong or tampered signature and never ingests", async () => {
    expect((await call(request({ signed: false }))).status).toBe(401);
    expect((await call(request({ headers: { "x-feedferret-signature": "sha256=" + "0".repeat(64) } }))).status).toBe(401);
    const tampered = request({ recipient: "tok@news.example", headers: { "x-feedferret-recipient": "evil@news.example" } });
    expect(await json(await call(tampered))).toEqual({ error: "invalid-signature" });
    expect(h.ingest).not.toHaveBeenCalled();
    expect(h.db.inboundMailSource.update).not.toHaveBeenCalled();
  });

  it("rejects replays outside the window with a distinct code, accepts inside it", async () => {
    const old = await call(request({ timestamp: nowSecs() - 301 }));
    expect(old.status).toBe(401);
    expect(await json(old)).toEqual({ error: "timestamp-out-of-window" });
    expect((await call(request({ timestamp: nowSecs() + 301 }))).status).toBe(401);
    expect((await call(request({ timestamp: nowSecs() - 299 }))).status).toBe(200);
    expect((await call(request({ timestamp: nowSecs() + 299 }))).status).toBe(200);
  });

  it("accepts Postmark-style HTTP Basic credentials and the JSON adapter", async () => {
    const postmark = JSON.stringify({ From: "News <news@example.org>", OriginalRecipient: "tok@news.example", Subject: "Hi", TextBody: "plain", HtmlBody: "<p>html</p>" });
    const ok = request({
      signed: false,
      body: postmark,
      headers: { "content-type": "application/json", authorization: `Basic ${Buffer.from(`feedferret:${SECRET}`).toString("base64")}` },
    });
    const res = await call(ok);
    expect(res.status).toBe(200);
    expect(await json(res)).toMatchObject({ format: "postmark" });
    expect((h.ingest.mock.calls[0][1] as { recipients: string[] }).recipients).toContain("tok@news.example");

    const bad = request({ signed: false, body: postmark, headers: { "content-type": "application/json", authorization: `Basic ${Buffer.from("feedferret:nope").toString("base64")}` } });
    expect((await call(bad)).status).toBe(401);
  });

  it("answers 403 for a paused source before reading the body, 404 for unknown or non-webhook sources", async () => {
    h.source.paused = true;
    expect((await call(request())).status).toBe(403);
    h.source.paused = false;
    h.source.kind = "imap";
    expect((await call(request())).status).toBe(404);
    h.source.kind = "cloudflare-disconnected";
    expect((await call(request())).status).toBe(404);
    h.db.inboundMailSource.findUnique.mockResolvedValueOnce(null);
    expect((await call(request())).status).toBe(404);
    expect((await call(request(), "bad id!")).status).toBe(404);
    expect(h.ingest).not.toHaveBeenCalled();
  });

  it("answers 503 while the source has no readable secret", async () => {
    h.source.webhookSecret = null;
    expect((await call(request())).status).toBe(503);
    expect(h.ingest).not.toHaveBeenCalled();
  });

  it("answers 413 for an oversized body (declared or streamed) and for a mail the ingest finds too large", async () => {
    const declared = request({ headers: { "content-length": String(MAX_WEBHOOK_BODY_BYTES + 1) } });
    expect((await call(declared)).status).toBe(413);
    expect(h.ingest).not.toHaveBeenCalled();

    h.ingest.mockResolvedValueOnce({ status: "too-large" });
    const res = await call(request());
    expect(res.status).toBe(413);
    expect(h.db.inboundMailSource.update).toHaveBeenLastCalledWith(expect.objectContaining({ data: expect.objectContaining({ lastError: "mail-too-large" }) }));
  });

  it("accepts and drops mail for unknown or revoked addresses (no retry, no bounce)", async () => {
    for (const status of ["unknown-token", "inactive", "no-token", "rate-limited", "duplicate"]) {
      h.ingest.mockResolvedValueOnce({ status });
      const res = await call(request());
      expect(res.status).toBe(200);
      expect(await json(res)).toMatchObject({ ok: true, status });
    }
    expect(h.after).not.toHaveBeenCalled();
  });

  it("counts an unparseable mail on the source and keeps answering 200", async () => {
    h.ingest.mockResolvedValueOnce({ status: "parse-error" });
    expect((await call(request())).status).toBe(200);
    expect(h.db.inboundMailSource.update).toHaveBeenLastCalledWith(expect.objectContaining({ data: expect.objectContaining({ errorCount: { increment: 1 }, lastError: "mail-unparseable" }) }));
  });

  it("answers 415 / 400 for payloads it cannot read", async () => {
    expect((await call(request({ headers: { "content-type": "image/png" } }))).status).toBe(415);
    expect((await call(request({ body: "{not json", headers: { "content-type": "application/json" } }))).status).toBe(400);
    expect((await call(request({ body: JSON.stringify({ hello: "world" }), headers: { "content-type": "application/json" } }))).status).toBe(400);
    expect(h.ingest).not.toHaveBeenCalled();
  });

  it("answers 500 (sender retries) when the ingest breaks on infrastructure", async () => {
    h.ingest.mockRejectedValueOnce(new Error("db down with secret " + SECRET));
    const res = await call(request());
    expect(res.status).toBe(500);
    expect(JSON.stringify(h.logs)).not.toContain(SECRET);
  });

  it("rate limits per source and client: 60 mails/min", async () => {
    const ip = "198.51.100.77";
    for (let i = 0; i < 60; i++) expect((await call(request({ ip }))).status).toBe(200);
    const limited = await call(request({ ip }));
    expect(limited.status).toBe(429);
    expect(limited.headers.get("retry-after")).toBeTruthy();
    // Another client is unaffected.
    expect((await call(request({ ip: "198.51.100.78" }))).status).toBe(200);
  });

  it("counts failed authentications per client: from the 11th the answer is 429, but a valid request is never locked out", async () => {
    const ip = "198.51.100.99";
    for (let i = 0; i < 10; i++) expect((await call(request({ ip, signed: false }))).status).toBe(401);
    const locked = await call(request({ ip, signed: false }));
    expect(locked.status).toBe(429);
    expect(await json(locked)).toEqual({ error: "too-many-failed-attempts" });
    expect((await call(request({ ip }))).status).toBe(200);
    expect((await call(request({ ip: "198.51.100.100", signed: false }))).status).toBe(401);
  });

  it("keys the limiters on the client only: a flood of random source ids creates no per-id entries and evicts nothing", async () => {
    // An existing limiter entry of another feature (sign-in lockout) must survive.
    const victim = "ip:victim-198.51.100.1";
    for (let i = 0; i < 4; i++) checkRateLimit(victim, RATE_LIMITS.authSignIn);
    const before = peekRateLimit(victim, RATE_LIMITS.authSignIn).remaining;
    const ip = "203.0.113.250";
    h.db.inboundMailSource.findUnique.mockResolvedValue(null);
    for (let i = 0; i < 30_000; i++) {
      await handleInboundEmailWebhook(request({ ip, signed: false }), `rnd${i.toString(36).padStart(8, "0")}`);
    }
    expect(peekRateLimit(victim, RATE_LIMITS.authSignIn).remaining).toBe(before);
    // Random ids from one client share ONE bucket: it is spent after 60 requests.
    expect((await call(request({ ip }), "anotherRandomId01")).status).toBe(429);
  });

  describe("before the body is buffered", () => {
    /** A body whose reads are observable. */
    function observed() {
      const state = { pulled: 0, cancelled: false };
      // highWaterMark 0: nothing is pulled until a consumer actually reads.
      const stream = new ReadableStream<Uint8Array>(
        {
          pull(controller) {
            state.pulled += 1;
            controller.enqueue(new TextEncoder().encode("x"));
            controller.close();
          },
          cancel() {
            state.cancelled = true;
          },
        },
        { highWaterMark: 0 },
      );
      return { state, stream };
    }
    const withStream = (stream: ReadableStream<Uint8Array>, headers: Record<string, string>) =>
      new Request("http://localhost/api/webhooks/inbound-email/src_webhook_1", {
        method: "POST",
        headers: { "x-forwarded-for": `203.0.113.${(ipSeq = (ipSeq + 1) % 250)}`, "content-type": "message/rfc822", ...headers },
        body: stream,
        duplex: "half",
      } as RequestInit);
    const ts = () => String(nowSecs());
    const fakeSignature = `sha256=${"a".repeat(64)}`;

    it.each([
      ["wrong Basic password", { authorization: `Basic ${Buffer.from("u:wrong").toString("base64")}` }, "invalid-credentials"],
      ["malformed signature", { "x-feedferret-signature": "sha256=zz", "x-feedferret-timestamp": ts() }, "invalid-signature"],
      ["missing timestamp", { "x-feedferret-signature": fakeSignature }, "invalid-signature"],
      ["non-numeric timestamp", { "x-feedferret-signature": fakeSignature, "x-feedferret-timestamp": "soon" }, "invalid-signature"],
      ["timestamp outside the window", { "x-feedferret-signature": fakeSignature, "x-feedferret-timestamp": String(nowSecs() - 600) }, "timestamp-out-of-window"],
      ["no credentials at all", {}, "unauthorized"],
    ])("rejects %s without reading a byte", async (_name, headers, error) => {
      const { state, stream } = observed();
      const res = await call(withStream(stream, headers));
      expect(res.status).toBe(401);
      expect(await json(res)).toEqual({ error });
      expect(state.pulled).toBe(0);
      expect(inFlightWebhookRequests()).toBe(0);
    });

    it("accepts correct Basic credentials before the body arrives", async () => {
      const { stream } = observed();
      const res = await call(withStream(stream, { authorization: `Basic ${Buffer.from(`u:${SECRET}`).toString("base64")}`, "content-type": "application/json" }));
      // The tiny body is not a Postmark/Mailgun payload, but it was read: 400, not 401.
      expect(res.status).toBe(400);
    });

    it(`buffers at most ${MAX_CONCURRENT_WEBHOOK_REQUESTS} bodies at once and answers 503 + Retry-After beyond that`, async () => {
      const controllers: ReadableStreamDefaultController<Uint8Array>[] = [];
      const stalledRequest = () =>
        withStream(new ReadableStream<Uint8Array>({ start: (c) => void controllers.push(c) }), {
          "x-feedferret-signature": fakeSignature,
          "x-feedferret-timestamp": ts(),
        });
      const pending = Array.from({ length: MAX_CONCURRENT_WEBHOOK_REQUESTS }, () => call(stalledRequest()));
      await vi.waitFor(() => expect(inFlightWebhookRequests()).toBe(MAX_CONCURRENT_WEBHOOK_REQUESTS));

      const busy = await call(stalledRequest());
      expect(busy.status).toBe(503);
      expect(busy.headers.get("retry-after")).toBe("5");
      expect(await json(busy)).toEqual({ error: "busy" });
      // The cap does not touch requests that fail the cheap checks.
      expect((await call(request({ signed: false }))).status).toBe(401);

      // Finishing the bodies frees the slots (bad signature: 401 each).
      controllers.slice(0, MAX_CONCURRENT_WEBHOOK_REQUESTS).forEach((c) => c.close());
      expect((await Promise.all(pending)).map((r) => r.status)).toEqual(Array(MAX_CONCURRENT_WEBHOOK_REQUESTS).fill(401));
      expect(inFlightWebhookRequests()).toBe(0);
      expect((await call(request())).status).toBe(200);
    });
  });

  it("never logs bodies, subjects, headers or secrets", async () => {
    await call(request());
    await call(request({ signed: false }));
    await call(request({ timestamp: nowSecs() - 1000 }));
    h.ingest.mockResolvedValueOnce({ status: "parse-error" });
    await call(request());
    const logged = h.logs.join("\n");
    for (const forbidden of [SECRET, "BODY-MARKER-1234", "Hello secret subject", "a@b.example", "tok@news.example", "sha256="]) {
      expect(logged).not.toContain(forbidden);
    }
  });
});
