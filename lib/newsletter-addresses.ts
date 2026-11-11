// N1 PR B: per-user newsletter addresses on top of the admin's inbound source.
import { db } from "@/lib/db";
import { generateNewsletterToken, newsletterAddressFor } from "@/lib/inbound-email";

/** Most addresses a user may hold (active + deactivated). */
export const MAX_NEWSLETTER_ADDRESSES = 25;

export type InboundSourceSummary = { id: string; kind: string; address: string | null; paused: boolean };

/** The inbound source user addresses derive from (IMAP first), or null when none is set up. */
export async function getInboundSource(): Promise<InboundSourceSummary | null> {
  const sources = await db.inboundMailSource.findMany({
    where: { address: { not: null } },
    select: { id: true, kind: true, address: true, paused: true },
    orderBy: { createdAt: "asc" },
  });
  return sources.find((s) => s.kind === "imap") ?? sources[0] ?? null;
}

export function addressString(source: InboundSourceSummary, token: string): string | null {
  return newsletterAddressFor({ kind: source.kind, address: source.address }, token);
}

/** Deterministic id of a user's first address: concurrent first loads collide on it instead of creating two. */
export function primaryNewsletterAddressId(userId: string): string {
  return `nl-primary-${userId}`;
}

/**
 * The user's oldest active address; created on first use. Idempotent: the
 * first address gets a deterministic primary key, so two concurrent first
 * loads hit a unique violation and the loser re-reads the winner's row.
 */
export async function ensurePrimaryNewsletterAddress(userId: string): Promise<{ id: string; token: string }> {
  const findActive = () =>
    db.newsletterAddress.findFirst({
      where: { userId, isActive: true },
      orderBy: [{ createdAt: "asc" }, { id: "asc" }],
      select: { id: true, token: true },
    });
  const existing = await findActive();
  if (existing) return existing;
  const id = primaryNewsletterAddressId(userId);
  try {
    return await db.newsletterAddress.create({ data: { id, userId, token: generateNewsletterToken() }, select: { id: true, token: true } });
  } catch (error) {
    const raced = await findActive();
    if (raced) return raced;
    // The deterministic row exists but is deactivated and nothing else is active
    // (only reachable by editing the DB): a fresh random-id address.
    const row = await db.newsletterAddress.findUnique({ where: { id }, select: { id: true } });
    if (!row) throw error;
    return db.newsletterAddress.create({ data: { userId, token: generateNewsletterToken() }, select: { id: true, token: true } });
  }
}

/** Spec §10: the settings section is hidden for non-admins until an inbox exists. */
export async function isNewsletterSectionVisible(isAdmin: boolean): Promise<boolean> {
  if (isAdmin) return true;
  return (await getInboundSource()) !== null;
}
