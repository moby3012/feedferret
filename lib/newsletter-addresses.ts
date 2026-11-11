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

/** The user's oldest active address; created on first use. */
export async function ensurePrimaryNewsletterAddress(userId: string): Promise<{ id: string; token: string }> {
  const existing = await db.newsletterAddress.findFirst({
    where: { userId, isActive: true },
    orderBy: [{ createdAt: "asc" }, { id: "asc" }],
    select: { id: true, token: true },
  });
  if (existing) return existing;
  return db.newsletterAddress.create({ data: { userId, token: generateNewsletterToken() }, select: { id: true, token: true } });
}
