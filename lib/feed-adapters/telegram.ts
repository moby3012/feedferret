// I/O adapter; all preview parsing stays in the HTML worker.
import { safeFetch, readTextWithLimit } from "../ssrf";
import { runInHtmlWorker } from "../html-worker";
import type { DiscoveryBudget } from "../discovery-budget";

const RESERVED = new Set(["s", "joinchat", "addstickers", "addemoji", "proxy", "socks", "share", "login", "iv", "c", "boost"]);
export function telegramChannel(input: string): string | null {
  try {
    const url = new URL(input);
    if (!["https:", "http:"].includes(url.protocol) || !["t.me", "telegram.me"].includes(url.hostname) || url.port || url.username || url.password) return null;
    const match = /^\/(?:s\/)?([a-z][\w]{3,31})(?:\/\d+)?\/?$/i.exec(url.pathname);
    return match && !RESERVED.has(match[1].toLowerCase()) ? match[1].toLowerCase() : null;
  } catch { return null; }
}

export async function fetchTelegram(channel: string, options: { signal?: AbortSignal; budget?: DiscoveryBudget } = {}) {
  const url = `https://t.me/s/${channel}`;
  if (options.budget && !options.budget.take(url)) throw new Error("Discovery request budget exhausted");
  const timeout = AbortSignal.timeout(options.budget?.requestTimeoutMs() ?? 15_000);
  const signal = options.signal ? AbortSignal.any([options.signal, timeout]) : timeout;
  const response = await safeFetch(url, { signal });
  if (!response.ok) {
    await response.body?.cancel();
    // 404/410 = no such public channel. Anything else (429, 5xx, 403 …) is a
    // temporary/transport condition: surface the status so host backoff and the
    // rate-limited/blocked discovery hints apply, instead of "does not exist".
    if (response.status === 404 || response.status === 410) throw new Error("Telegram channel is private, unavailable, or does not exist");
    throw new Error(`Fetch failed: ${response.status} ${response.statusText}`.trim());
  }
  return runInHtmlWorker({ task: "telegram", html: await readTextWithLimit(response, 4 * 1024 * 1024), url, channel });
}
