import type { FetchedFeed } from "./feed-item-fields";
import { parseApiSourceUrl } from "./feed-adapters/api-source-url";
import { getTwitchCredentials, twitchRequest, fetchTwitchFeed } from "./twitch";

type AccountState = "ready" | "unconfigured" | "missing";
type ApiSourceProvider = {
  fetch: (account: string, variant: string, signal?: AbortSignal) => Promise<FetchedFeed>;
  verifyAccount: (account: string, signal?: AbortSignal) => Promise<AccountState>;
};
/** API adapters return the same item contract as RSS/JSON/scraper sources, so
 * persistence, dedupe, filters and OPML remain on the common pipeline. */
const providers: Record<string, ApiSourceProvider> = {
  twitch: {
    fetch: fetchTwitchFeed,
    async verifyAccount(account, signal) {
      const credentials = await getTwitchCredentials();
      if (!credentials) return "unconfigured";
      return (await twitchRequest("users", { login: account }, credentials, signal)).length ? "ready" : "missing";
    },
  },
};
export async function fetchApiPlatformSource(url: string, signal?: AbortSignal): Promise<FetchedFeed> {
  const parsed = parseApiSourceUrl(url);
  if (!parsed) throw new Error("Invalid API platform feed URL");
  return providers[parsed.source.id].fetch(parsed.account, parsed.variant, signal);
}

/** Providers verify the account once, including offline/empty channels. */
export async function verifyApiPlatformAccount(source: string, account: string, signal?: AbortSignal): Promise<AccountState> {
  return providers[source]?.verifyAccount(account, signal) ?? "missing";
}
