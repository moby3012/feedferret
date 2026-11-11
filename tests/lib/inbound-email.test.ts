import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  detectConfirmationUrl,
  evaluateSenderAuth,
  extractRecipientTokens,
  generateNewsletterToken,
  isNewsletterToken,
  isTrackingImage,
  newsletterAddressFor,
  normalizeMessageId,
  parseListId,
  parseListUnsubscribe,
  senderIdentity,
  stripTrackingParams,
} from "@/lib/inbound-email";
import { SECRET_COLUMNS, openSecret, sealSecret } from "@/lib/secret-box";

const T = "abcdefghijklmnopqrstuvwxyz";

describe("tokens and addresses", () => {
  it("generates unguessable base32 tokens", () => {
    const tokens = new Set(Array.from({ length: 200 }, generateNewsletterToken));
    expect(tokens.size).toBe(200);
    for (const t of tokens) expect(isNewsletterToken(t)).toBe(true);
  });

  it("builds plus-addresses for IMAP and token@domain for domain sources", () => {
    expect(newsletterAddressFor({ kind: "imap", address: "Box+old@Example.org" }, T)).toBe(`box+ff-${T}@example.org`);
    expect(newsletterAddressFor({ kind: "cloudflare", address: "nl.example.org" }, T)).toBe(`${T}@nl.example.org`);
    expect(newsletterAddressFor({ kind: "webhook", address: null }, T)).toBeNull();
  });

  it("extracts tokens from both address forms, ignores everything else", () => {
    expect(extractRecipientTokens([`Reader <box+ff-${T}@example.org>`])).toEqual([T]);
    expect(extractRecipientTokens([`${T.toUpperCase()}@nl.example.org, other@example.org`])).toEqual([T]);
    expect(extractRecipientTokens([`${T}+tech@nl.example.org`])).toEqual([T]);
    expect(extractRecipientTokens(["box+ff-short@example.org", "plain@example.org", `box+ff-${T}x@example.org`])).toEqual([]);
  });
});

describe("header parsing", () => {
  it("normalizes Message-ID", () => {
    expect(normalizeMessageId(" <abc@x.y> ")).toBe("abc@x.y");
    expect(normalizeMessageId("")).toBeNull();
    expect(normalizeMessageId("<has space@x>")).toBeNull();
  });

  it("parses List-Id with phrase", () => {
    expect(parseListId('"Morning Brew" <Brew.List.Example>')).toEqual({ id: "brew.list.example", phrase: "Morning Brew" });
    expect(parseListId("<x.example>")).toEqual({ id: "x.example", phrase: null });
  });

  it("parses List-Unsubscribe / -Post (https + mailto only, one-click needs https)", () => {
    expect(parseListUnsubscribe("<mailto:u@x.example>, <https://x.example/u?t=1>", "List-Unsubscribe=One-Click"))
      .toEqual({ url: "https://x.example/u?t=1", mailto: "mailto:u@x.example", oneClick: true });
    expect(parseListUnsubscribe("<http://x.example/u>, <javascript:alert(1)>", "List-Unsubscribe=One-Click"))
      .toEqual({ url: null, mailto: null, oneClick: false });
  });

  it("groups senders: List-Id, then domain, then full address on shared platforms", () => {
    expect(senderIdentity({ listId: "<a.b>", fromName: "A", fromAddress: "x@b.example" }).key).toBe("list:a.b");
    expect(senderIdentity({ listId: null, fromName: "News", fromAddress: "hi@mail.brand.example" })).toMatchObject({ key: "domain:brand.example", title: "News" });
    expect(senderIdentity({ listId: null, fromName: "Writer", fromAddress: "writer@substack.com" }).key).toBe("from:writer@substack.com");
  });
});

describe("hygiene helpers", () => {
  it("strips tracking params only", () => {
    expect(stripTrackingParams("https://x.example/a?utm_source=n&id=3&mc_eid=9")).toBe("https://x.example/a?id=3");
    expect(stripTrackingParams("https://x.example/a?id=3")).toBe("https://x.example/a?id=3");
    expect(stripTrackingParams("mailto:a@b?utm_source=x")).toBe("mailto:a@b?utm_source=x");
  });

  it("recognises tracking images", () => {
    expect(isTrackingImage({ src: "https://cdn.example/a.png", width: "1", height: "1" })).toBe(true);
    expect(isTrackingImage({ src: "https://cdn.example/a.png", style: "width:1px;height:1px" })).toBe(true);
    expect(isTrackingImage({ src: "https://x.list-manage.com/track/open.php?u=1" })).toBe(true);
    expect(isTrackingImage({ src: "https://email.brand.example/o/abc" })).toBe(true);
    expect(isTrackingImage({ src: "https://cdn.example/hero.png", width: "600" })).toBe(false);
    expect(isTrackingImage({ src: "https://cdn.example/hero.png", style: "width:100%" })).toBe(false);
  });

  it("only flags confirmations with a confirm-ish subject/body and link", () => {
    const links = [{ href: "https://x.example/unsubscribe", text: "Unsubscribe" }, { href: "https://x.example/c?t=1", text: "Anmeldung bestätigen" }];
    expect(detectConfirmationUrl("Bitte bestätige deine Anmeldung", "", links)).toBe("https://x.example/c?t=1");
    expect(detectConfirmationUrl("Weekly issue", "Nothing to confirm here? no.", links)).toBeNull();
    expect(detectConfirmationUrl("Confirm your subscription", "", [links[0]])).toBeNull();
  });
});

describe("inbound mail source secrets", () => {
  beforeEach(() => {
    vi.stubEnv("AUTH_SECRET", "inbound-email-test-secret-0123456789");
    vi.stubEnv("FEEDFERRET_ENCRYPTION_KEY", "");
  });
  afterEach(() => vi.unstubAllEnvs());

  it("registers the new secret columns with their own AAD purpose", () => {
    const purposes = SECRET_COLUMNS.filter((c) => c.model === "inboundMailSource").map((c) => c.purpose);
    expect(purposes).toEqual(["inboundMailSource.credentials", "inboundMailSource.webhookSecret"]);
    const sealed = sealSecret("inboundMailSource.credentials", '{"user":"a","password":"b"}');
    expect(sealed.startsWith("ff2.")).toBe(true);
    expect(openSecret("inboundMailSource.credentials", sealed, "plaintext").value).toBe('{"user":"a","password":"b"}');
    expect(() => openSecret("inboundMailSource.webhookSecret", sealed, "plaintext")).toThrow();
  });
});

describe("evaluateSenderAuth (verdict only from the configured receiver)", () => {
  const ar = (value: string) => ({ key: "authentication-results", value });
  const verdict = (...args: Parameters<typeof evaluateSenderAuth>) => evaluateSenderAuth(...args).verdict;

  it("never yields a verdict without a trusted authserv-id (forged pass -> none)", () => {
    const forged = evaluateSenderAuth([ar("mx.google.com; dmarc=pass header.from=bank.example")], "a@bank.example");
    expect(forged).toMatchObject({ verdict: "none", verified: false, authservId: "mx.google.com" });
    expect(forged.results[0]).toMatchObject({ method: "dmarc", result: "pass" });
  });

  it("uses the topmost header with the trusted id and ignores others", () => {
    const headers = [ar("forged.example; dmarc=pass"), ar("mx.google.com; dmarc=fail header.from=bank.example"), ar("mx.google.com; dmarc=pass")];
    expect(evaluateSenderAuth(headers, "a@bank.example", "mx.google.com")).toMatchObject({ verdict: "fail", verified: true });
    expect(verdict([ar("forged.example; dmarc=pass")], "a@x.example", "mx.google.com")).toBe("none");
  });

  it("requires DKIM/SPF alignment with From when there is no DMARC result", () => {
    const t = "mx.r";
    expect(verdict([ar("mx.r; dkim=pass header.d=attacker.example; spf=pass smtp.mailfrom=b@attacker.example")], "a@bank.example", t)).toBe("none");
    expect(verdict([ar("mx.r; dkim=pass header.d=bank.example")], "news@mail.bank.example", t)).toBe("pass");
    expect(verdict([ar("mx.r; spf=softfail smtp.mailfrom=bank.example")], "a@bank.example", t)).toBe("fail");
  });

  it("never derives a verdict from ARC (seals unverified), keeps it as evidence", () => {
    const arc = (value: string) => ({ key: "arc-authentication-results", value });
    const res = evaluateSenderAuth([arc("i=1; mx.a; dmarc=fail"), arc("i=2; mx.google.com; dmarc=pass")], "a@x.example", "mx.google.com");
    expect(res).toMatchObject({ verdict: "none", verified: false, source: "arc", authservId: "mx.google.com" });
    expect(evaluateSenderAuth([], "a@x.example")).toMatchObject({ verdict: "none", source: null });
  });
});
