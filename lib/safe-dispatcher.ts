import dns, { type LookupOptions, type LookupAddress } from "node:dns";
import type { LookupFunction } from "node:net";
import { Agent, ProxyAgent, type Dispatcher } from "undici";
import { isPrivateIp } from "./private-ip";

export type Resolver = (hostname: string, options: LookupOptions & { all: true }, callback: (error: NodeJS.ErrnoException | null, addresses: LookupAddress[]) => void) => void;

/** Validate the exact DNS answers returned to net.connect, including happy eyeballs. */
export function createSafeLookup(resolve: Resolver = dns.lookup): LookupFunction {
  return ((hostname: string, opts: LookupOptions, cb: (...args: unknown[]) => void) => {
    resolve(hostname, { ...opts, all: true }, (error, addresses) => {
      if (error) return cb(error);
      if (!addresses.length || addresses.some(({ address }) => isPrivateIp(address))) {
        return cb(Object.assign(new Error("hostname resolves to a private IP"), { code: "ERR_SSRF_PRIVATE_IP" }));
      }
      if (opts.all) cb(null, addresses);
      else cb(null, addresses[0].address, addresses[0].family);
    });
  }) as LookupFunction;
}
export const safeLookup = createSafeLookup();
export const pinnedAgent = new Agent({ connect: { lookup: safeLookup } });
export const pinnedInsecureAgent = new Agent({ connect: { lookup: safeLookup, rejectUnauthorized: false } });
const internalAgent = new Agent();
const internalInsecureAgent = new Agent({ connect: { rejectUnauthorized: false } });
const proxies = new Map<string, ProxyAgent>();

export function proxyAgentFor(proxy: string, options: { allowInternal?: boolean; insecureTls?: boolean } = {}) {
  const key = JSON.stringify([proxy, !!options.allowInternal, !!options.insecureTls]);
  const cached = proxies.get(key);
  if (cached) { proxies.delete(key); proxies.set(key, cached); return cached; }
  const agent = new ProxyAgent({ uri: proxy, proxyTls: { lookup: options.allowInternal ? undefined : safeLookup }, requestTls: { rejectUnauthorized: !options.insecureTls } });
  proxies.set(key, agent);
  if (proxies.size > 32) {
    const oldest = proxies.keys().next().value!;
    const evicted = proxies.get(oldest)!;
    proxies.delete(oldest);
    void evicted.close().catch(() => undefined);
  }
  return agent;
}
export function dispatcherFor(options: { proxy?: string; proxyAllowInternal?: boolean; allowInternal?: boolean; insecureTls?: boolean }): Dispatcher {
  if (options.proxy) return proxyAgentFor(options.proxy, { allowInternal: options.proxyAllowInternal ?? options.allowInternal, insecureTls: options.insecureTls });
  if (options.allowInternal) return options.insecureTls ? internalInsecureAgent : internalAgent;
  return options.insecureTls ? pinnedInsecureAgent : pinnedAgent;
}
