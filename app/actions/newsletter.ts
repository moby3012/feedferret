"use server";

// N1 PR B: the user's own newsletter addresses (/settings/newsletter).

import { auth } from "@/auth";
import { db } from "@/lib/db";
import { pickFields } from "@/lib/pick-fields";
import { generateNewsletterToken } from "@/lib/inbound-email";
import { logger } from "@/lib/logger";
import { checkRateLimit, RATE_LIMITS } from "@/lib/rate-limit";
import { resolveNewsletterTarget, sendOneClickUnsubscribe, type NewsletterFeedActions, type NewsletterTarget } from "@/lib/newsletter-reader";
import { addressString, ensurePrimaryNewsletterAddress, getInboundSource, MAX_NEWSLETTER_ADDRESSES } from "@/lib/newsletter-addresses";

export interface NewsletterAddressView {
  id: string;
  address: string;
  description: string | null;
  isActive: boolean;
  isPrimary: boolean;
  lastReceivedAt: string | null;
  createdAt: string;
}

export interface NewsletterInboxView {
  /** false: the admin has not set up a mail inbox yet (explanatory state). */
  available: boolean;
  paused: boolean;
  isAdmin: boolean;
  addresses: NewsletterAddressView[];
  limit: number;
}

async function requireUser() {
  const session = await auth();
  const userId = session?.user?.id;
  if (!userId) throw new Error("Unauthorized");
  const user = await db.user.findUnique({ where: { id: userId }, select: { isActive: true, role: true } });
  if (!user?.isActive) throw new Error("Unauthorized");
  return { userId, isAdmin: user.role === "ADMIN" };
}

export async function getMyNewsletterInbox(): Promise<NewsletterInboxView> {
  const { userId, isAdmin } = await requireUser();
  const source = await getInboundSource();
  if (!source) return { available: false, paused: false, isAdmin, addresses: [], limit: MAX_NEWSLETTER_ADDRESSES };
  const primary = await ensurePrimaryNewsletterAddress(userId);
  const rows = await db.newsletterAddress.findMany({
    where: { userId },
    orderBy: [{ createdAt: "asc" }, { id: "asc" }],
    select: { id: true, token: true, description: true, isActive: true, lastReceivedAt: true, createdAt: true },
    take: MAX_NEWSLETTER_ADDRESSES,
  });
  const addresses = rows.flatMap((row) => {
    const address = addressString(source, row.token);
    return address
      ? [{
          id: row.id,
          address,
          description: row.description,
          isActive: row.isActive,
          isPrimary: row.id === primary.id,
          lastReceivedAt: row.lastReceivedAt?.toISOString() ?? null,
          createdAt: row.createdAt.toISOString(),
        }]
      : [];
  });
  return { available: true, paused: source.paused, isAdmin, addresses, limit: MAX_NEWSLETTER_ADDRESSES };
}

/** "Eigene Adresse pro Newsletter": one more address, optionally labelled. */
export async function createMyNewsletterAddress(input: unknown): Promise<{ ok: true; inbox: NewsletterInboxView } | { ok: false; error: "unavailable" | "limit" }> {
  const { userId } = await requireUser();
  if (!(await getInboundSource())) return { ok: false, error: "unavailable" };
  const { description } = pickFields((input ?? {}) as { description?: unknown }, ["description"]);
  const label = typeof description === "string" ? description.replace(/\s+/g, " ").trim().slice(0, 80) : "";
  const count = await db.newsletterAddress.count({ where: { userId } });
  if (count >= MAX_NEWSLETTER_ADDRESSES) return { ok: false, error: "limit" };
  await db.newsletterAddress.create({ data: { userId, token: generateNewsletterToken(), description: label || null } });
  return { ok: true, inbox: await getMyNewsletterInbox() };
}

/** Deactivate (mail to it is dropped) or re-activate one of the user's own addresses. */
export async function setMyNewsletterAddressActive(input: unknown): Promise<{ ok: boolean; error?: "last-active"; inbox?: NewsletterInboxView }> {
  const { userId } = await requireUser();
  const { id, active } = pickFields((input ?? {}) as { id?: unknown; active?: unknown }, ["id", "active"]);
  if (typeof id !== "string" || typeof active !== "boolean") return { ok: false };
  // Keep one working address: to replace a leaked one, create a new one first.
  if (!active) {
    const others = await db.newsletterAddress.count({ where: { userId, isActive: true, id: { not: id } } });
    if (others === 0) return { ok: false, error: "last-active" };
  }
  // Ownership is part of the WHERE: another user's id updates nothing.
  const updated = await db.newsletterAddress.updateMany({ where: { id, userId }, data: { isActive: active } });
  if (updated.count !== 1) return { ok: false };
  return { ok: true, inbox: await getMyNewsletterInbox() };
}

// ---------------------------------------------------------------------------
// N1 PR D: reader / feed-menu actions

function pickTarget(input: unknown): NewsletterTarget | null {
  const { articleId, feedId } = pickFields((input ?? {}) as { articleId?: unknown; feedId?: unknown }, ["articleId", "feedId"]);
  if (typeof articleId === "string" && articleId && articleId.length <= 128) return { articleId };
  if (typeof feedId === "string" && feedId && feedId.length <= 128) return { feedId };
  return null;
}

/** What "Newsletter abbestellen" / "Adresse sperren" can do for one of the user's newsletter feeds (null: not a newsletter / not theirs). */
export async function getNewsletterFeedActions(input: unknown): Promise<NewsletterFeedActions | null> {
  const { userId } = await requireUser();
  const target = pickTarget(input);
  if (!target) return null;
  return resolveNewsletterTarget(userId, target);
}

export type UnsubscribeNewsletterResult =
  | { ok: true; feedId: string; feedName: string }
  | { ok: false; error: "not-found" | "no-one-click" | "failed" | "rate-limited"; status?: number };

/**
 * RFC 8058 one-click unsubscribe of an article's (or feed's) newsletter. Only
 * for mail with a verified ("pass") sender (see unsubscribeFor). The
 * URL is always re-read from the user's own row; the client only names the
 * article or feed. Senders without one-click get "no-one-click" (the client
 * opens their page or a mail on the user's click instead).
 */
export async function unsubscribeNewsletter(input: unknown): Promise<UnsubscribeNewsletterResult> {
  const { userId } = await requireUser();
  const target = pickTarget(input);
  if (!target) return { ok: false, error: "not-found" };
  // Each call can make one outbound POST: bounded per user.
  if (!checkRateLimit(`user:${userId}`, RATE_LIMITS.newsletterUnsubscribe).success) return { ok: false, error: "rate-limited" };
  const resolved = await resolveNewsletterTarget(userId, target);
  if (!resolved) return { ok: false, error: "not-found" };
  const unsubscribe = resolved.unsubscribe;
  if (unsubscribe?.method !== "one-click" || !unsubscribe.url) {
    logger.info("[newsletter] unsubscribe without one-click", { userId, feedId: resolved.feedId });
    return { ok: false, error: "no-one-click" };
  }
  const result = await sendOneClickUnsubscribe(unsubscribe.url, { userId, feedId: resolved.feedId });
  return result.ok ? { ok: true, feedId: resolved.feedId, feedName: resolved.feedName } : result;
}
