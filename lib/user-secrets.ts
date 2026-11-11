// Readers for per-user secret columns (security audit #2, M8). Values may be
// legacy plaintext or v2 `ff2.` ciphertext. A stored value the configured keys
// cannot open is reported as `unreadable` (logged once, never the value): the
// channel is then skipped — never used without its token.
import { readPlainColumnState } from "@/lib/secret-box";

export { readTotpSecret } from "@/lib/totp-consume";

export type ChannelTokens = {
  telegramBotToken: string | null;
  gotifyToken: string | null;
  ntfyToken: string | null;
  /** Channels whose stored token exists but cannot be decrypted. */
  unreadable: { telegram: boolean; gotify: boolean; ntfy: boolean };
};

export function readChannelTokens(user: {
  telegramBotToken?: string | null;
  gotifyToken?: string | null;
  ntfyToken?: string | null;
} | null | undefined): ChannelTokens {
  const telegram = readPlainColumnState("user.telegramBotToken", user?.telegramBotToken);
  const gotify = readPlainColumnState("user.gotifyToken", user?.gotifyToken);
  const ntfy = readPlainColumnState("user.ntfyToken", user?.ntfyToken);
  return {
    telegramBotToken: telegram.value,
    gotifyToken: gotify.value,
    ntfyToken: ntfy.value,
    unreadable: { telegram: telegram.unreadable, gotify: gotify.unreadable, ntfy: ntfy.unreadable },
  };
}
