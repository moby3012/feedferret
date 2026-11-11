// N1 PR D: reader integration of newsletter articles — what the reader and the
// feed menu may offer (confirmation banner, sender warning, unsubscribe,
// "Adresse sperren") and the RFC 8058 one-click unsubscribe request.
//
// Every URL here comes from untrusted mail headers/bodies. Only http(s) links
// are ever handed to the browser (opened on a user click), and the only
// request the server makes is the one-click POST, through safeFetch (DNS
// pinning, no private networks, one hop, no redirects).
import { db } from "@/lib/db";
import { logger } from "@/lib/logger";
import { safeFetch, isTrustedFeedFetchingAllowed } from "@/lib/ssrf";
import { isE2eHarness } from "@/lib/ai/fake";
import { NEWSLETTER_SOURCE_TYPE } from "@/lib/newsletter-constants";
import { addressString, getInboundSource } from "@/lib/newsletter-addresses";
import type { NewsletterArticleMeta, NewsletterUnsubscribe } from "@/features/articles/types";

/** The RFC 8058 request body. */
export const ONE_CLICK_BODY = "List-Unsubscribe=One-Click";
const ONE_CLICK_TIMEOUT_MS = 10_000;

/** Article columns the newsletter view needs. */
export const NEWSLETTER_ARTICLE_SELECT = {
  feedId: true,
  emailSender: true,
  confirmationUrl: true,
  listUnsubscribeUrl: true,
  listUnsubscribeMailto: true,
  listUnsubscribeOneClick: true,
  newsletterAuth: true,
  newsletterAddressId: true,
  feed: { select: { sourceType: true } },
} as const;

export type NewsletterArticleRow = {
  feedId: string;
  emailSender: string | null;
  confirmationUrl: string | null;
  listUnsubscribeUrl: string | null;
  listUnsubscribeMailto: string | null;
  listUnsubscribeOneClick: boolean | null;
  newsletterAuth: string | null;
  newsletterAddressId: string | null;
  feed: { sourceType: string | null } | null;
};

/**
 * https only. Ingest already drops anything else; plain http is accepted only
 * inside the e2e harness (its fixture server has no TLS).
 */
export function safeWebUrl(raw: string | null | undefined, allowHttp = isE2eHarness()): string | null {
  if (!raw || raw.length > 2000) return null;
  try {
    const url = new URL(raw);
    if (url.protocol === "https:" || (allowHttp && url.protocol === "http:")) return url.toString();
  } catch {
    // not a URL
  }
  return null;
}

function safeMailto(raw: string | null | undefined): string | null {
  if (!raw || raw.length > 1000 || !/^mailto:[^\s<>"]+$/i.test(raw)) return null;
  return raw;
}

/** One-click when the sender supports RFC 8058, else the https page, else mailto. */
export function unsubscribeFor(row: Pick<NewsletterArticleRow, "listUnsubscribeUrl" | "listUnsubscribeMailto" | "listUnsubscribeOneClick">, allowHttp?: boolean): NewsletterUnsubscribe | null {
  const url = safeWebUrl(row.listUnsubscribeUrl, allowHttp);
  const mailto = safeMailto(row.listUnsubscribeMailto);
  if (url && row.listUnsubscribeOneClick === true) return { method: "one-click", url, mailto };
  if (url) return { method: "link", url, mailto };
  if (mailto) return { method: "mailto", url: null, mailto };
  return null;
}

export function isNewsletterRow(row: Pick<NewsletterArticleRow, "newsletterAuth" | "feed">): boolean {
  // newsletterAuth is set on every ingested mail; the feed check covers sender feeds.
  return row.newsletterAuth != null || row.feed?.sourceType === NEWSLETTER_SOURCE_TYPE;
}

/**
 * The address "Adresse sperren" would deactivate: the one that delivered the
 * mail (or the address pinned to this feed), when it is active and NOT the
 * user's primary (oldest active) address — that one stays, it is the address
 * the user hands out by default. Ownership is part of every WHERE.
 */
export async function blockableAddressFor(userId: string, addressId: string | null, feedId: string): Promise<{ id: string; address: string } | null> {
  const candidate = addressId
    ? await db.newsletterAddress.findFirst({ where: { id: addressId, userId, isActive: true }, select: { id: true, token: true } })
    : await db.newsletterAddress.findFirst({ where: { feedId, userId, isActive: true }, orderBy: [{ createdAt: "asc" }, { id: "asc" }], select: { id: true, token: true } });
  if (!candidate) return null;
  const primary = await db.newsletterAddress.findFirst({
    where: { userId, isActive: true },
    orderBy: [{ createdAt: "asc" }, { id: "asc" }],
    select: { id: true },
  });
  if (!primary || primary.id === candidate.id) return null;
  const source = await getInboundSource();
  const address = source ? addressString(source, candidate.token) : null;
  return address ? { id: candidate.id, address } : null;
}

/** Reader metadata of one of `userId`'s articles (already ownership-checked row), or null for web articles. */
export async function newsletterMetaFor(userId: string, row: NewsletterArticleRow): Promise<NewsletterArticleMeta | null> {
  if (!isNewsletterRow(row)) return null;
  const auth = row.newsletterAuth === "pass" || row.newsletterAuth === "fail" ? row.newsletterAuth : "none";
  return {
    sender: row.emailSender,
    confirmationUrl: safeWebUrl(row.confirmationUrl),
    auth,
    unsubscribe: unsubscribeFor(row),
    blockAddress: await blockableAddressFor(userId, row.newsletterAddressId, row.feedId),
  };
}

export type NewsletterTarget = { articleId: string } | { feedId: string };

export interface NewsletterFeedActions extends NewsletterArticleMeta {
  feedId: string;
  feedName: string;
}

/**
 * Resolve an article or a newsletter feed of `userId` to its newsletter view.
 * A feed uses its newest mail that carries unsubscribe data (else its newest
 * mail). Another user's id resolves to null.
 */
export async function resolveNewsletterTarget(userId: string, target: NewsletterTarget): Promise<NewsletterFeedActions | null> {
  const select = { ...NEWSLETTER_ARTICLE_SELECT, feed: { select: { sourceType: true, name: true } } } as const;
  let row;
  if ("articleId" in target) {
    row = await db.article.findFirst({ where: { id: target.articleId, userId }, select });
  } else {
    const feed = await db.feed.findFirst({ where: { id: target.feedId, userId }, select: { id: true } });
    if (!feed) return null;
    const newest = { orderBy: [{ publishedAt: "desc" as const }, { id: "desc" as const }], select };
    row =
      (await db.article.findFirst({
        where: { feedId: feed.id, userId, OR: [{ listUnsubscribeUrl: { not: null } }, { listUnsubscribeMailto: { not: null } }] },
        ...newest,
      })) ?? (await db.article.findFirst({ where: { feedId: feed.id, userId, newsletterAuth: { not: null } }, ...newest }));
  }
  if (!row) return null;
  const meta = await newsletterMetaFor(userId, row);
  if (!meta) return null;
  return { ...meta, feedId: row.feedId, feedName: row.feed?.name ?? "" };
}

export type OneClickResult = { ok: true } | { ok: false; error: "failed"; status?: number };

/**
 * RFC 8058 one-click unsubscribe: a single POST with the fixed form body, no
 * cookies, no redirects (a redirect is not a confirmation). Internal targets
 * only when the admin allows internal feed URLs (same rule as feed fetching).
 */
export async function sendOneClickUnsubscribe(url: string, log: { userId: string; feedId: string }): Promise<OneClickResult> {
  try {
    const response = await safeFetch(
      url,
      {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded", "user-agent": "FeedFerret (List-Unsubscribe)" },
        body: ONE_CLICK_BODY,
        redirect: "manual",
        signal: AbortSignal.timeout(ONE_CLICK_TIMEOUT_MS),
      },
      { allowInternal: await isTrustedFeedFetchingAllowed(), context: "Unsubscribe" },
    );
    await response.body?.cancel().catch(() => undefined);
    if (response.ok) {
      logger.info("[newsletter] one-click unsubscribe sent", { ...log, status: response.status });
      return { ok: true };
    }
    logger.warn("[newsletter] one-click unsubscribe refused", { ...log, status: response.status });
    return { ok: false, error: "failed", status: response.status };
  } catch (error) {
    // Metadata only: the URL carries the subscriber token.
    logger.warn("[newsletter] one-click unsubscribe failed", { ...log, reason: error instanceof Error ? error.name : "error" });
    return { ok: false, error: "failed" };
  }
}
