import { createHash, randomBytes } from "crypto";

// Tokens are stored as SHA-256 hashes; the raw token is only ever returned once to the user.
// Format: ff_<base64url(32 random bytes)>
export function generateApiToken(): { raw: string; hash: string } {
  const raw = `ff_${randomBytes(32).toString("base64url")}`;
  return { raw, hash: hashApiToken(raw) };
}

export function hashApiToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}
