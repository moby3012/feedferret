// N1 PR D: reader actions — RFC 8058 one-click unsubscribe through safeFetch,
// ownership (another user's article/feed resolves to nothing), https only,
// and which address "Adresse sperren" may offer.
import { beforeEach, describe, expect, it, vi } from "vitest";

type Row = Record<string, any>;

const h = vi.hoisted(() => {
  const store = {
    session: { id: "bob" } as { id: string } | null,
    users: {
      bob: { role: "USER", isActive: true },
      eve: { role: "USER", isActive: true },
    } as Record<string, { role: string; isActive: boolean }>,
    feeds: [] as Row[],
    articles: [] as Row[],
    addresses: [] as Row[],
    source: { id: "src", kind: "imap", address: "box@example.com", paused: false } as Row | null,
  };
  const pick = (row: Row, select?: Record<string, any>) => {
    if (!select) return row;
    const out: Row = {};
    for (const [k, v] of Object.entries(select)) {
      if (k === "feed" && v?.select) {
        const feed = store.feeds.find((f) => f.id === row.feedId);
        out.feed = feed ? pick(feed, v.select) : null;
      } else out[k] = row[k];
    }
    return out;
  };
  const matches = (row: Row, where: Row = {}): boolean =>
    Object.entries(where).every(([k, v]) => {
      if (k === "OR") return (v as Row[]).some((w) => matches(row, w));
      if (v && typeof v === "object" && "not" in v) return row[k] !== v.not;
      return row[k] === v;
    });
  const sortNewest = (rows: Row[]) => [...rows].sort((a, b) => b.publishedAt - a.publishedAt);
  const sortOldest = (rows: Row[]) => [...rows].sort((a, b) => a.createdAt - b.createdAt || String(a.id).localeCompare(String(b.id)));
  const db = {
    user: { findUnique: vi.fn(async ({ where }: any) => store.users[where.id] ?? null) },
    feed: { findFirst: vi.fn(async ({ where, select }: any) => { const r = store.feeds.find((f) => matches(f, where)); return r ? pick(r, select) : null; }) },
    article: {
      findFirst: vi.fn(async ({ where, select }: any) => {
        const r = sortNewest(store.articles.filter((a) => matches(a, where)))[0];
        return r ? pick(r, select) : null;
      }),
    },
    newsletterAddress: {
      findFirst: vi.fn(async ({ where, select }: any) => {
        const r = sortOldest(store.addresses.filter((a) => matches(a, where)))[0];
        return r ? pick(r, select) : null;
      }),
      updateMany: vi.fn(async ({ where, data }: any) => {
        const rows = store.addresses.filter((a) => matches(a, where));
        rows.forEach((r) => Object.assign(r, data));
        return { count: rows.length };
      }),
      count: vi.fn(async ({ where }: any) => store.addresses.filter((a) => matches(a, where)).length),
    },
    inboundMailSource: { findMany: vi.fn(async () => (store.source ? [store.source] : [])) },
  };
  const safeFetch = vi.fn(async (_url: string, _init?: RequestInit, _opts?: Record<string, unknown>) => new Response("ok", { status: 200 }));
  const trusted = { value: false };
  const rateLimited = { value: false };
  const checkRateLimit = vi.fn((_id: string, _config: unknown) => ({ success: !rateLimited.value }));
  return { store, db, safeFetch, trusted, rateLimited, checkRateLimit };
});

vi.mock("@/auth", () => ({ auth: vi.fn(async () => (h.store.session ? { user: h.store.session } : null)) }));
vi.mock("@/lib/db", () => ({ db: h.db }));
vi.mock("@/lib/ssrf", () => ({ safeFetch: h.safeFetch, isTrustedFeedFetchingAllowed: vi.fn(async () => h.trusted.value) }));
vi.mock("@/lib/rate-limit", async (original) => ({ ...(await original<typeof import("@/lib/rate-limit")>()), checkRateLimit: h.checkRateLimit }));

import { getNewsletterFeedActions, unsubscribeNewsletter } from "@/app/actions/newsletter";
import { ONE_CLICK_BODY, safeWebUrl, unsubscribeFor } from "@/lib/newsletter-reader";

const ONE_CLICK_URL = "https://news.example.com/u/one-click?t=abc";

function seed() {
  h.store.session = { id: "bob" };
  h.store.feeds = [
    { id: "f-bob", userId: "bob", name: "Bob's Digest", sourceType: "newsletter" },
    { id: "f-eve", userId: "eve", name: "Eve's Digest", sourceType: "newsletter" },
  ];
  const base = {
    emailSender: "digest@news.example.com",
    confirmationUrl: null,
    listUnsubscribeMailto: "mailto:leave@news.example.com",
    newsletterAuth: "pass",
    newsletterAddressId: null,
    publishedAt: 1,
  };
  h.store.articles = [
    { ...base, id: "a-bob", userId: "bob", feedId: "f-bob", listUnsubscribeUrl: ONE_CLICK_URL, listUnsubscribeOneClick: true, newsletterAddressId: "addr-alias" },
    { ...base, id: "a-eve", userId: "eve", feedId: "f-eve", listUnsubscribeUrl: ONE_CLICK_URL, listUnsubscribeOneClick: true },
  ];
  h.store.addresses = [
    { id: "addr-primary", userId: "bob", token: "a".repeat(26), isActive: true, feedId: null, createdAt: 1 },
    { id: "addr-alias", userId: "bob", token: "b".repeat(26), isActive: true, feedId: null, createdAt: 2 },
  ];
  h.trusted.value = false;
  h.rateLimited.value = false;
  h.checkRateLimit.mockClear();
  h.safeFetch.mockClear();
  h.safeFetch.mockImplementation(async () => new Response("ok", { status: 200 }));
}

describe("unsubscribeNewsletter (RFC 8058 one-click)", () => {
  beforeEach(seed);

  it("POSTs List-Unsubscribe=One-Click through safeFetch, no redirects", async () => {
    const result = await unsubscribeNewsletter({ articleId: "a-bob" });
    expect(result).toEqual({ ok: true, feedId: "f-bob", feedName: "Bob's Digest" });
    expect(h.safeFetch).toHaveBeenCalledTimes(1);
    const [url, init, opts] = h.safeFetch.mock.calls[0];
    expect(url).toBe(ONE_CLICK_URL);
    expect(init?.method).toBe("POST");
    expect(init?.body).toBe("List-Unsubscribe=One-Click");
    expect(ONE_CLICK_BODY).toBe("List-Unsubscribe=One-Click");
    expect(new Headers(init?.headers).get("content-type")).toBe("application/x-www-form-urlencoded");
    expect(init?.redirect).toBe("manual");
    expect(opts).toMatchObject({ allowInternal: false, context: "Unsubscribe" });
    expect(init?.signal).toBeInstanceOf(AbortSignal);
    expect(init?.signal?.aborted).toBe(false);
  });

  it("allows internal targets only when the admin allows internal feed URLs", async () => {
    h.trusted.value = true;
    await unsubscribeNewsletter({ articleId: "a-bob" });
    expect(h.safeFetch.mock.calls[0][2]).toMatchObject({ allowInternal: true });
  });

  it("never POSTs for an unverified or failed sender (RFC 8058 needs a DKIM-covered header)", async () => {
    for (const auth of ["none", "fail", null]) {
      h.store.articles[0].newsletterAuth = auth;
      expect(await unsubscribeNewsletter({ articleId: "a-bob" })).toEqual({ ok: false, error: "no-one-click" });
    }
    expect(h.safeFetch).not.toHaveBeenCalled();
    h.store.articles[0].newsletterAuth = "none";
    // Degrades to the sender's page, opened by the user's click.
    expect((await getNewsletterFeedActions({ feedId: "f-bob" }))?.unsubscribe).toEqual({ method: "link", url: ONE_CLICK_URL, mailto: "mailto:leave@news.example.com" });
  });

  it("is rate limited per user", async () => {
    h.rateLimited.value = true;
    expect(await unsubscribeNewsletter({ articleId: "a-bob" })).toEqual({ ok: false, error: "rate-limited" });
    expect(h.checkRateLimit).toHaveBeenCalledWith("user:bob", expect.objectContaining({ limit: 10, windowSecs: 60 }));
    expect(h.safeFetch).not.toHaveBeenCalled();
  });

  it("works from the feed menu (feed id) with the newest mail's header", async () => {
    const result = await unsubscribeNewsletter({ feedId: "f-bob" });
    expect(result.ok).toBe(true);
    expect(h.safeFetch.mock.calls[0][0]).toBe(ONE_CLICK_URL);
  });

  it("feed menu: prefers a verified mail, never a failed one", async () => {
    const extra = (id: string, auth: string, publishedAt: number, url: string) => ({
      ...h.store.articles[0],
      id,
      newsletterAuth: auth,
      publishedAt,
      listUnsubscribeUrl: url,
    });
    // Newer "none" and newest "fail" mails must not win over the verified one.
    h.store.articles.push(extra("a-none", "none", 5, "https://news.example.com/u/unverified"));
    h.store.articles.push(extra("a-fail", "fail", 9, "https://evil.example/u/spoofed"));
    expect((await getNewsletterFeedActions({ feedId: "f-bob" }))?.unsubscribe?.url).toBe(ONE_CLICK_URL);
    await unsubscribeNewsletter({ feedId: "f-bob" });
    expect(h.safeFetch.mock.calls[0][0]).toBe(ONE_CLICK_URL);

    // No verified mail: the newest unverified one, as a link only (no server request).
    h.store.articles = h.store.articles.filter((a) => a.id !== "a-bob");
    expect((await getNewsletterFeedActions({ feedId: "f-bob" }))?.unsubscribe).toEqual({ method: "link", url: "https://news.example.com/u/unverified", mailto: "mailto:leave@news.example.com" });

    // Only failed mail: nothing to unsubscribe with.
    h.store.articles = h.store.articles.filter((a) => a.id !== "a-none");
    expect((await getNewsletterFeedActions({ feedId: "f-bob" }))?.unsubscribe).toBeNull();
    expect(await unsubscribeNewsletter({ feedId: "f-bob" })).toEqual({ ok: false, error: "no-one-click" });
    expect(h.safeFetch).toHaveBeenCalledTimes(1);
  });

  it("refuses another user's article or feed without any request", async () => {
    expect(await unsubscribeNewsletter({ articleId: "a-eve" })).toEqual({ ok: false, error: "not-found" });
    expect(await unsubscribeNewsletter({ feedId: "f-eve" })).toEqual({ ok: false, error: "not-found" });
    expect(await getNewsletterFeedActions({ feedId: "f-eve" })).toBeNull();
    expect(h.safeFetch).not.toHaveBeenCalled();
  });

  it("never takes a URL from the client", async () => {
    await unsubscribeNewsletter({ articleId: "a-bob", url: "https://evil.example/", listUnsubscribeUrl: "https://evil.example/" });
    expect(h.safeFetch.mock.calls[0][0]).toBe(ONE_CLICK_URL);
  });

  it("does not POST without RFC 8058 support or to a non-https URL", async () => {
    h.store.articles[0].listUnsubscribeOneClick = false;
    expect(await unsubscribeNewsletter({ articleId: "a-bob" })).toEqual({ ok: false, error: "no-one-click" });
    h.store.articles[0].listUnsubscribeOneClick = true;
    h.store.articles[0].listUnsubscribeUrl = "http://news.example.com/u";
    expect(await unsubscribeNewsletter({ articleId: "a-bob" })).toEqual({ ok: false, error: "no-one-click" });
    expect(h.safeFetch).not.toHaveBeenCalled();
  });

  it("reports a refused, redirected or blocked request as failed", async () => {
    h.safeFetch.mockImplementationOnce(async () => new Response("no", { status: 500 }));
    expect(await unsubscribeNewsletter({ articleId: "a-bob" })).toEqual({ ok: false, error: "failed", status: 500 });
    h.safeFetch.mockImplementationOnce(async () => {
      throw new Error("Unsubscribe URL points to a private IP");
    });
    expect(await unsubscribeNewsletter({ articleId: "a-bob" })).toEqual({ ok: false, error: "failed" });
  });

  it("requires a signed-in, active user", async () => {
    h.store.session = null;
    await expect(unsubscribeNewsletter({ articleId: "a-bob" })).rejects.toThrow("Unauthorized");
    expect(h.safeFetch).not.toHaveBeenCalled();
  });

  it("ignores junk input", async () => {
    expect(await unsubscribeNewsletter(null)).toEqual({ ok: false, error: "not-found" });
    expect(await unsubscribeNewsletter({ articleId: 42 })).toEqual({ ok: false, error: "not-found" });
  });
});

describe("getNewsletterFeedActions", () => {
  beforeEach(seed);

  it("offers blocking only the dedicated (non-primary) address that delivered the mail", async () => {
    const view = await getNewsletterFeedActions({ feedId: "f-bob" });
    expect(view?.unsubscribe).toEqual({ method: "one-click", url: ONE_CLICK_URL, mailto: "mailto:leave@news.example.com" });
    expect(view?.blockAddress).toEqual({ id: "addr-alias", address: `box+ff-${"b".repeat(26)}@example.com` });

    h.store.articles[0].newsletterAddressId = "addr-primary";
    expect((await getNewsletterFeedActions({ feedId: "f-bob" }))?.blockAddress).toBeNull();

    h.store.articles[0].newsletterAddressId = "addr-alias";
    h.store.addresses[1].isActive = false;
    expect((await getNewsletterFeedActions({ feedId: "f-bob" }))?.blockAddress).toBeNull();
  });

  it("falls back to the address pinned to the feed for older mail", async () => {
    h.store.articles[0].newsletterAddressId = null;
    h.store.addresses[1].feedId = "f-bob";
    expect((await getNewsletterFeedActions({ feedId: "f-bob" }))?.blockAddress?.id).toBe("addr-alias");
  });

  it("never offers another user's address", async () => {
    h.store.addresses[1].userId = "eve";
    expect((await getNewsletterFeedActions({ feedId: "f-bob" }))?.blockAddress).toBeNull();
  });
});

describe("unsubscribeFor / safeWebUrl", () => {
  it("prefers one-click, then the https page, then mailto", () => {
    expect(unsubscribeFor({ listUnsubscribeUrl: ONE_CLICK_URL, listUnsubscribeOneClick: true, listUnsubscribeMailto: null, newsletterAuth: "pass" }, false)?.method).toBe("one-click");
    expect(unsubscribeFor({ listUnsubscribeUrl: ONE_CLICK_URL, listUnsubscribeOneClick: true, listUnsubscribeMailto: null, newsletterAuth: "none" }, false)?.method).toBe("link");
    expect(unsubscribeFor({ listUnsubscribeUrl: ONE_CLICK_URL, listUnsubscribeOneClick: null, listUnsubscribeMailto: null, newsletterAuth: "pass" }, false)?.method).toBe("link");
    expect(unsubscribeFor({ listUnsubscribeUrl: null, listUnsubscribeOneClick: null, listUnsubscribeMailto: "mailto:x@y.z?subject=unsubscribe", newsletterAuth: "pass" }, false)).toEqual({
      method: "mailto",
      url: null,
      mailto: "mailto:x@y.z?subject=unsubscribe",
    });
    expect(unsubscribeFor({ listUnsubscribeUrl: null, listUnsubscribeOneClick: null, listUnsubscribeMailto: null, newsletterAuth: "pass" }, false)).toBeNull();
  });

  it("drops non-https and script URLs", () => {
    expect(safeWebUrl("javascript:alert(1)", true)).toBeNull();
    expect(safeWebUrl("http://example.com/x", false)).toBeNull();
    expect(safeWebUrl("http://example.com/x", true)).toBe("http://example.com/x");
    expect(safeWebUrl("https://example.com/x", false)).toBe("https://example.com/x");
    expect(unsubscribeFor({ listUnsubscribeUrl: null, listUnsubscribeOneClick: null, listUnsubscribeMailto: "javascript:alert(1)", newsletterAuth: "pass" }, false)).toBeNull();
  });
});
