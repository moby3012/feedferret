// M8 e2e helpers: seal values exactly like the server would (v2 `ff2.`), using
// the e2e server's AUTH_SECRET, and compute TOTP codes.
import { loadKeyring, sealV2 } from "../../lib/secret-box-core.mjs";

/** Must match `webServer.env.AUTH_SECRET` in playwright.config.ts (imported there). */
export const E2E_AUTH_SECRET = "e2e-0123456789abcdef0123456789abcd-k";

export function sealForE2e(purpose: string, value: string): string {
  return sealV2(purpose, value, loadKeyring({ AUTH_SECRET: E2E_AUTH_SECRET }));
}
