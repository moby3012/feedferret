import { createHmac, timingSafeEqual } from "crypto";

function secret(): string {
  const value = process.env.AUTH_SECRET;
  if (!value) {
    throw new Error("AUTH_SECRET must be set to generate or verify Telegram mark-read URLs");
  }
  return value;
}

export function generateMarkReadUrl(articleId: string, userId: string, baseUrl: string): string {
  const expiry = Math.floor(Date.now() / 1000) + 7 * 86400; // 7 days
  const payload = `${articleId}:${userId}:${expiry}`;
  const sig = createHmac("sha256", secret()).update(payload).digest("hex").slice(0, 16);
  const params = new URLSearchParams({ id: articleId, uid: userId, exp: String(expiry), sig });
  return `${baseUrl}/api/telegram/callback?${params}`;
}

export function verifyMarkReadUrl(articleId: string, userId: string, expiry: string, sig: string): boolean {
  const exp = Number(expiry);
  if (!exp || exp < Math.floor(Date.now() / 1000)) return false;
  const payload = `${articleId}:${userId}:${expiry}`;
  const expected = createHmac("sha256", secret()).update(payload).digest("hex").slice(0, 16);
  const sigBuf = Buffer.from(sig);
  const expectedBuf = Buffer.from(expected);
  if (sigBuf.length !== expectedBuf.length) return false;
  return timingSafeEqual(sigBuf, expectedBuf);
}
