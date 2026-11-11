// Readers for per-user secret columns (security audit #2, M8). Values may be
// legacy plaintext or v2 `ff2.` ciphertext; undecryptable values read as null
// (logged once, never the value), so a channel is skipped instead of crashing.
import { readPlainColumnOrNull } from "@/lib/secret-box";

export { readTotpSecret } from "@/lib/totp-consume";

export function readChannelTokens(user: {
  telegramBotToken?: string | null;
  gotifyToken?: string | null;
  ntfyToken?: string | null;
} | null | undefined) {
  return {
    telegramBotToken: readPlainColumnOrNull("user.telegramBotToken", user?.telegramBotToken),
    gotifyToken: readPlainColumnOrNull("user.gotifyToken", user?.gotifyToken),
    ntfyToken: readPlainColumnOrNull("user.ntfyToken", user?.ntfyToken),
  };
}
