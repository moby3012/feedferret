const PLACEHOLDERS = ["your-super-secret-key-change-this", "your-secret-here", "change-me", "secret", "changeme", "build-time-secret-only"];

export function validateAuthSecret(secret = process.env.AUTH_SECRET, production = process.env.NODE_ENV === "production") {
  if (!production) return;
  if (!secret || secret.trim().length < 32 || PLACEHOLDERS.some(value => secret.trim().toLowerCase() === value)) {
    const message = "AUTH_SECRET must contain at least 32 random characters and must not be a placeholder. Generate it with openssl rand -base64 32. Refusing to start.";
    console.error(message);
    throw new Error(message);
  }
}
