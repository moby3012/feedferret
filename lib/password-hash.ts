import bcrypt from "bcryptjs";

/**
 * The one bcrypt cost passwords are stored with (web registration, password change, `create-user` in
 * scripts/feedferret-cli.mjs, which duplicates this number: keep them in sync). One cost matters for
 * more than strength: sign-in pays for exactly one bcrypt verification whether the address is real or
 * not, which only hides account existence if real hashes and the dummy hash cost the same.
 */
export const BCRYPT_COST = 12;

/** A valid hash of a throwaway string at `BCRYPT_COST`, compared against when an address has no usable password. */
export const DUMMY_PASSWORD_HASH = "$2b$12$PYn8LnGlcNipP/xDgcf6j.2GNX8VEcrw4J83e6loev6mb10GzXeCW";

export function hashPassword(password: string): Promise<string> {
  return bcrypt.hash(password, BCRYPT_COST);
}

/** Whether a stored hash was made at another cost than `BCRYPT_COST` (older accounts: 10). */
export function needsRehash(hash: string): boolean {
  try {
    return typeof bcrypt.getRounds === "function" && bcrypt.getRounds(hash) !== BCRYPT_COST;
  } catch {
    return false;
  }
}
