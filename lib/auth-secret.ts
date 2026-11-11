const PLACEHOLDERS = ["your-super-secret-key-change-this", "your-secret-here", "change-me", "secret", "changeme", "build-time-secret-only"];

export function validateAuthSecret(secret = process.env.AUTH_SECRET, production = process.env.NODE_ENV === "production") {
  if (!production) return;
  if (!secret || secret.trim().length < 32 || PLACEHOLDERS.some(value => secret.trim().toLowerCase() === value)) {
    const message = "AUTH_SECRET must contain at least 32 random characters and must not be a placeholder. Generate it with openssl rand -base64 32. Refusing to start.";
    console.error(message);
    throw new Error(message);
  }
  validateEncryptionKey(process.env.FEEDFERRET_ENCRYPTION_KEY, production);
}

/**
 * FEEDFERRET_ENCRYPTION_KEY (optional, security audit #2, M8): the master key
 * for stored secrets, independent of AUTH_SECRET. When set it must be base64
 * (or base64url) of at least 32 random bytes. The value itself is never logged.
 */
export function validateEncryptionKey(value: string | undefined, production = process.env.NODE_ENV === "production") {
  if (!production || value === undefined || value.trim() === "") return;
  const trimmed = value.trim();
  const valid = /^[A-Za-z0-9+/_-]+={0,2}$/.test(trimmed) && Buffer.from(trimmed, "base64").length >= 32;
  if (!valid) {
    const message = "FEEDFERRET_ENCRYPTION_KEY must be base64 of at least 32 random bytes. Generate it with openssl rand -base64 32. Refusing to start.";
    console.error(message);
    throw new Error(message);
  }
}
