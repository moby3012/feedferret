import { timingSafeEqual } from "crypto";

export function validateInternalApiKey(request: Request): boolean {
  const key = process.env.INTERNAL_API_KEY;
  if (!key) return false;

  const authHeader = request.headers.get("Authorization");
  if (!authHeader?.startsWith("Bearer ")) return false;

  const token = authHeader.slice(7).trim();
  const tokenBuf = Buffer.from(token);
  const keyBuf = Buffer.from(key);
  if (tokenBuf.length !== keyBuf.length) return false;
  return timingSafeEqual(tokenBuf, keyBuf);
}
