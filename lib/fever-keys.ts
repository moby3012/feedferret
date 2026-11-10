import { db } from "@/lib/db";
import { hashApiToken } from "@/lib/token";

export const isLegacyFeverKey = (value: string) => /^[a-f0-9]{32}$/.test(value);

/** Guard every write against concurrent rotation/revocation. Portable to both providers. */
export async function backfillFeverKeys() {
  const users = await db.user.findMany({ where: { apiFeverKey: { not: null } }, select: { id: true, apiFeverKey: true } });
  for (const user of users) {
    if (user.apiFeverKey && isLegacyFeverKey(user.apiFeverKey)) {
      await db.user.updateMany({ where: { id: user.id, apiFeverKey: user.apiFeverKey }, data: { apiFeverKey: hashApiToken(user.apiFeverKey) } });
    }
  }
  const tokens = await db.apiToken.findMany({ where: { feverKey: { not: null } }, select: { id: true, feverKey: true } });
  for (const token of tokens) {
    if (token.feverKey && isLegacyFeverKey(token.feverKey)) {
      await db.apiToken.updateMany({ where: { id: token.id, feverKey: token.feverKey }, data: { feverKey: hashApiToken(token.feverKey) } });
    }
  }
}
