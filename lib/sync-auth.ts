import { timingSafeEqual } from "node:crypto";

export function hasSyncSecret(request: Request): boolean {
  if (!process.env.SYNC_SECRET) return false;
  const expected = Buffer.from(`Bearer ${process.env.SYNC_SECRET}`);
  const actual = Buffer.from(request.headers.get("authorization") ?? "");
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}
