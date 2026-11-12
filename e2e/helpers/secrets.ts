// M8 e2e helpers: seal values exactly like the server would (v2 `ff2.`), using
// the e2e server's AUTH_SECRET, and compute TOTP codes.
import { isV2, loadKeyring, openSecret, sealV2 } from "../../lib/secret-box-core.mjs";

/** Must match `webServer.env.AUTH_SECRET` in playwright.config.ts (imported there). */
export const E2E_AUTH_SECRET = "e2e-0123456789abcdef0123456789abcd-k";

export function sealForE2e(purpose: string, value: string): string {
  return sealV2(purpose, value, loadKeyring({ AUTH_SECRET: E2E_AUTH_SECRET }));
}

/** Decrypt a stored v2 value with the e2e key; throws when the value is not v2 (i.e. stored in the clear). */
export function openForE2e(purpose: string, stored: unknown): string {
  if (typeof stored !== "string") throw new Error(`${purpose} is not stored v2-sealed`);
  if (!stored || !isV2(stored)) throw new Error(`${purpose} is not stored v2-sealed`);
  return openSecret(purpose, stored, { legacy: "plaintext", keyring: loadKeyring({ AUTH_SECRET: E2E_AUTH_SECRET }) }).value;
}
