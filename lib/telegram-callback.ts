import { hmacHex, legacyMacSecret, verifyMac } from "@/lib/secret-box";

// Signed mark-read links (security audit #2, M8): still signed with the raw
// AUTH_SECRET so a rollback keeps sent buttons working; verification also
// accepts the domain-separated HKDF key the next release signs with.
const TELEGRAM_MAC_PURPOSE = "telegram-callback";

function sign(key: string | Buffer, payload: string) {
  return hmacHex(key, payload).slice(0, 16);
}

export function generateMarkReadUrl(articleId: string, userId: string, baseUrl: string): string {
  const expiry = Math.floor(Date.now() / 1000) + 7 * 86400; // 7 days
  const payload = `${articleId}:${userId}:${expiry}`;
  const sig = sign(legacyMacSecret(), payload);
  const params = new URLSearchParams({ id: articleId, uid: userId, exp: String(expiry), sig });
  return `${baseUrl}/api/telegram/callback?${params}`;
}

export function verifyMarkReadUrl(articleId: string, userId: string, expiry: string, sig: string): boolean {
  const exp = Number(expiry);
  if (!exp || exp < Math.floor(Date.now() / 1000)) return false;
  const payload = `${articleId}:${userId}:${expiry}`;
  return verifyMac(TELEGRAM_MAC_PURPOSE, sig, (key) => sign(key, payload));
}
