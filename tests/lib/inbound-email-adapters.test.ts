// N1 PR C: webhook payload adapters. The rebuilt MIME must come out of the same
// parser the ingest uses with the right subject / sender / bodies / headers, and
// hostile field values must not inject headers.
import { describe, expect, it } from "vitest";
import PostalMime from "postal-mime";
import { adaptInboundPayload, buildMime } from "@/lib/inbound-email-adapters";

const parse = (raw: Buffer | string) => PostalMime.parse(typeof raw === "string" ? raw : new Uint8Array(raw));
const adapt = (type: string | null, body: string | object, rcpt: string | null = null) =>
  adaptInboundPayload(type, Buffer.from(typeof body === "string" ? body : JSON.stringify(body)), rcpt);

const PIXEL = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGP4z8DwHwAFAAH/q842iQAAAABJRU5ErkJggg==", "base64").toString("base64");

describe("raw RFC 822", () => {
  it.each(["message/rfc822", "text/plain; charset=utf-8", "application/octet-stream"])("passes %s through untouched with the signed envelope recipient", async (type) => {
    const result = await adapt(type, "Subject: x\r\n\r\nbody", "tok@news.example");
    expect(result).toMatchObject({ ok: true, format: "rfc822", recipients: ["tok@news.example"] });
    expect(result.ok && Buffer.from(result.raw as Buffer).toString()).toBe("Subject: x\r\n\r\nbody");
  });
  it("has no recipients without the header (ingest then falls back to the mail headers)", async () => {
    expect(await adapt("message/rfc822", "Subject: x\r\n\r\nb")).toMatchObject({ ok: true, recipients: [] });
  });
  it("rejects an empty body and unknown content types", async () => {
    expect(await adapt("message/rfc822", "")).toEqual({ ok: false, error: "invalid-payload" });
    expect(await adapt("image/png", "x")).toEqual({ ok: false, error: "unsupported-content-type" });
    expect(await adapt(null, "x")).toEqual({ ok: false, error: "unsupported-content-type" });
  });
});

describe("Postmark inbound JSON", () => {
  const payload = {
    From: "Weekly Ferret <hello@weekly-ferret.example>",
    FromFull: { Email: "hello@weekly-ferret.example", Name: "Weekly Ferret" },
    To: "tok@news.example",
    ToFull: [{ Email: "tok@news.example", Name: "" }],
    OriginalRecipient: "tok@news.example",
    Subject: "Grüße aus dem Bau",
    Date: "Tue, 10 Nov 2026 08:00:00 +0000",
    MessageID: "0b6eb9c4-1f8e-4a3a-9d4e-111111111111",
    TextBody: "Hallo\nWelt",
    HtmlBody: '<p>Hallo <img src="cid:logo@ferret"> Welt</p>',
    Headers: [
      { Name: "Message-ID", Value: "<orig-1@weekly-ferret.example>" },
      { Name: "List-Id", Value: "Weekly Ferret <weekly.ferret.example>" },
      { Name: "List-Unsubscribe", Value: "<https://weekly-ferret.example/u/1>" },
      { Name: "List-Unsubscribe-Post", Value: "List-Unsubscribe=One-Click" },
      { Name: "Content-Type", Value: 'multipart/mixed; boundary="evil"' },
    ],
    Attachments: [
      { Name: "logo.png", Content: PIXEL, ContentType: "image/png", ContentID: "cid:logo@ferret", ContentLength: 70 },
      { Name: "invoice.pdf", Content: "JVBERi0=", ContentType: "application/pdf", ContentID: "" },
    ],
  };

  it("rebuilds a message the ingest parser understands", async () => {
    const result = await adapt("application/json; charset=utf-8", payload);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.format).toBe("postmark");
    expect(result.recipients).toEqual(["tok@news.example", "tok@news.example", "tok@news.example"]);
    const mail = await parse(result.raw);
    expect(mail.subject).toBe("Grüße aus dem Bau");
    expect(mail.from).toMatchObject({ address: "hello@weekly-ferret.example", name: "Weekly Ferret" });
    expect(mail.messageId).toBe("<orig-1@weekly-ferret.example>");
    expect(mail.text?.trim()).toBe("Hallo\nWelt");
    expect(mail.html).toContain("Hallo");
    const headers = Object.fromEntries(mail.headers.map((hd) => [hd.key, hd.value]));
    expect(headers["list-unsubscribe"]).toContain("https://weekly-ferret.example/u/1");
    expect(headers["list-unsubscribe-post"]).toBe("List-Unsubscribe=One-Click");
    // Only the inline image survives; the PDF is dropped, the provider's own Content-Type is ignored.
    expect(mail.attachments.map((a) => a.contentId)).toEqual(["<logo@ferret>"]);
    expect(mail.attachments[0].mimeType).toBe("image/png");
  });

  it("falls back to Postmark's MessageID when the original has none, and to the top-level fields without Headers", async () => {
    const result = await adapt("application/json", { ...payload, Headers: undefined, Attachments: undefined });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const mail = await parse(result.raw);
    expect(mail.messageId).toBe("<0b6eb9c4-1f8e-4a3a-9d4e-111111111111@inbound.postmarkapp.com>");
    expect(mail.subject).toBe("Grüße aus dem Bau");
    expect(mail.attachments).toHaveLength(0);
  });

  it("uses RawEmail verbatim when the server includes it", async () => {
    const result = await adapt("application/json", { ...payload, RawEmail: "Subject: raw\r\n\r\nraw body" });
    expect(result).toMatchObject({ ok: true, format: "postmark", raw: "Subject: raw\r\n\r\nraw body" });
  });

  it("cannot inject headers or smuggle a Bcc through field values", async () => {
    const result = await adapt("application/json", {
      ...payload,
      Subject: "Hi\r\nBcc: victim@example.com\r\nX-Evil: 1",
      Headers: [
        { Name: "X-Good", Value: "ok\r\nX-Injected: yes" },
        { Name: "Bad Name: x\r\nX-Injected2", Value: "v" },
        { Name: "MIME-Version", Value: "2.0" },
      ],
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const mail = await parse(result.raw);
    const keys = mail.headers.map((hd) => hd.key);
    for (const key of ["bcc", "x-evil", "x-injected", "x-injected2"]) expect(keys).not.toContain(key);
    expect(mail.headers.find((hd) => hd.key === "x-good")?.value).toBe("ok X-Injected: yes");
    expect(mail.headers.filter((hd) => hd.key === "mime-version")).toHaveLength(1);
  });

  it("refuses a payload without any body", async () => {
    expect(await adapt("application/json", { ...payload, TextBody: "", HtmlBody: "", Headers: [] })).toEqual({ ok: false, error: "invalid-payload" });
  });

  it("drops oversized and non-image inline parts", () => {
    const mime = buildMime({
      headers: [["Subject", "x"]],
      text: null,
      html: "<p>x</p>",
      inline: [
        { cid: "a", contentType: "application/pdf", base64: "AAAA" },
        { cid: "b", contentType: "image/svg+xml", base64: "AAAA" },
        { cid: "c", contentType: "image/png", base64: "A".repeat(3_000_000) },
      ],
    })!;
    expect(mime).not.toContain("Content-ID");
  });
});

describe("Mailgun route forward", () => {
  const fields = {
    recipient: "tok@news.example",
    sender: "bounce@mg.weekly-ferret.example",
    from: "Weekly Ferret <hello@weekly-ferret.example>",
    subject: "Mailgun issue",
    "message-headers": JSON.stringify([
      ["Message-Id", "<mg-1@weekly-ferret.example>"],
      ["List-Unsubscribe", "<mailto:unsub@weekly-ferret.example>"],
    ]),
    "body-plain": "plain text",
    "body-html": "<p>html text</p>",
    "attachment-count": "1",
    timestamp: "1700000000",
    token: "abc",
    signature: "def",
  };

  it("understands url-encoded forms", async () => {
    const result = await adapt("application/x-www-form-urlencoded", new URLSearchParams(fields).toString(), null);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.format).toBe("mailgun");
    expect(result.recipients).toEqual(["tok@news.example"]);
    const mail = await parse(result.raw);
    expect(mail.subject).toBe("Mailgun issue");
    expect(mail.messageId).toBe("<mg-1@weekly-ferret.example>");
    expect(mail.from?.address).toBe("hello@weekly-ferret.example");
    expect(mail.html).toContain("html text");
    expect(mail.headers.find((hd) => hd.key === "list-unsubscribe")?.value).toContain("mailto:unsub@weekly-ferret.example");
  });

  it("understands multipart forms and ignores uploaded files", async () => {
    const form = new FormData();
    for (const [key, value] of Object.entries(fields)) form.append(key, value);
    form.append("attachment-1", new Blob(["%PDF-1.4"], { type: "application/pdf" }), "invoice.pdf");
    const request = new Request("http://x.example/", { method: "POST", body: form });
    const body = Buffer.from(await request.arrayBuffer());
    const result = await adaptInboundPayload(request.headers.get("content-type"), body, null);
    expect(result).toMatchObject({ ok: true, format: "mailgun" });
    if (result.ok) expect((await parse(result.raw)).attachments).toHaveLength(0);
  });

  it("uses body-mime verbatim and the JSON variant with the same keys", async () => {
    const mime = await adapt("application/x-www-form-urlencoded", new URLSearchParams({ recipient: "tok@news.example", "body-mime": "Subject: mime\r\n\r\nm" }).toString());
    expect(mime).toMatchObject({ ok: true, format: "mailgun", raw: "Subject: mime\r\n\r\nm" });
    expect(await adapt("application/json", fields)).toMatchObject({ ok: true, format: "mailgun" });
  });

  it("refuses a form without any body", async () => {
    expect(await adapt("application/x-www-form-urlencoded", "recipient=tok%40news.example&subject=x")).toEqual({ ok: false, error: "invalid-payload" });
  });
});

describe("generic relay JSON", () => {
  it("accepts { raw, recipient }", async () => {
    expect(await adapt("application/json", { raw: "Subject: x\r\n\r\nb", recipient: ["a@b.example", "c@d.example"] })).toMatchObject({
      ok: true,
      format: "rfc822",
      raw: "Subject: x\r\n\r\nb",
      recipients: ["a@b.example", "c@d.example"],
    });
  });
  it("caps the number of recipients", async () => {
    const result = await adapt("application/json", { raw: "x", recipient: Array.from({ length: 100 }, (_, i) => `r${i}@x.example`) });
    expect(result.ok && result.recipients.length).toBe(20);
  });
  it("reports broken JSON and non-objects", async () => {
    expect(await adapt("application/json", "{")).toEqual({ ok: false, error: "invalid-json" });
    expect(await adapt("application/json", "[1,2]")).toEqual({ ok: false, error: "invalid-payload" });
    expect(await adapt("application/json", {})).toEqual({ ok: false, error: "invalid-payload" });
  });
});
