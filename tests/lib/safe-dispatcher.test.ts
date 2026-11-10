import { afterEach, describe, expect, it, vi } from "vitest";
import http from "node:http";
import https from "node:https";
import tls from "node:tls";
import net from "node:net";
import { readFileSync } from "node:fs";
import type { LookupOptions } from "node:dns";

const dnsMock = vi.hoisted(() => ({ calls: 0, address: "127.0.0.1" }));
vi.mock("dns/promises", () => ({ default: { lookup: vi.fn(async () => { dnsMock.calls++; return [{ address: "8.8.8.8", family: 4 }]; }) } }));
vi.mock("node:dns", () => ({ default: { lookup: (_host: string, _opts: unknown, cb: Function) => { dnsMock.calls++; cb(null, [{ address: dnsMock.address, family: 4 }]); } } }));
vi.mock("@/lib/db", () => ({ db: {} }));
import { createSafeLookup, proxyAgentFor } from "../../lib/safe-dispatcher";
import { safeFetch, fetchWithSsrfProtection } from "../../lib/ssrf";
import { startEgressProxy } from "../../lib/egress-proxy";

async function listen(server: net.Server) {
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  return (server.address() as net.AddressInfo).port;
}
const cleanup: (() => Promise<unknown>)[] = [];
afterEach(async () => { vi.unstubAllGlobals(); for (const close of cleanup.splice(0).reverse()) await close(); });
function lookup(addresses: string[], all = false) {
  return new Promise<unknown[]>((resolve, reject) => {
    const fn = createSafeLookup((_host, _opts, cb) => cb(null, addresses.map(address => ({ address, family: net.isIP(address) }))));
    (fn as Function)("target.test", { all }, (err: Error | null, ...result: unknown[]) => err ? reject(err) : resolve(result));
  });
}
describe("socket lookup", () => {
  it.each(["127.0.0.1", "10.0.0.1", "0.0.0.0", "169.254.169.254", "169.254.1.2", "::1", "fe80::1", "fc00::1", "::ffff:127.0.0.1", "::ffff:a00:1"])("rejects %s including mixed DNS answers", async address => {
    await expect(lookup(["8.8.8.8", address], true)).rejects.toMatchObject({ code: "ERR_SSRF_PRIVATE_IP" });
  });
  it("preserves all and single-address callback shapes", async () => {
    expect(await lookup(["8.8.8.8"])).toEqual(["8.8.8.8", 4]);
    expect(await lookup(["2606:4700:4700::1111"], true)).toEqual([[{ address: "2606:4700:4700::1111", family: 6 }]]);
  });
  it.each([false, true])("blocks public preflight → private socket lookup (insecureTls=%s)", async insecureTls => {
    let requests = 0;
    const server = http.createServer((_req, res) => { requests++; res.end("should never connect"); });
    const port = await listen(server);
    cleanup.push(() => new Promise<void>(resolve => server.close(() => resolve())));
    dnsMock.calls = 0;
    await expect(safeFetch(`http://rebind.test:${port}`, {}, { insecureTls })).rejects.toMatchObject({ cause: { code: "ERR_SSRF_PRIVATE_IP" } });
    expect(dnsMock.calls).toBe(2);
    expect(requests).toBe(0);
  });
  it("also pins the TLS-disabled agent on HTTPS", async () => {
    await expect(safeFetch("https://rebind.test:444", {}, { insecureTls: true })).rejects.toMatchObject({ cause: { code: "ERR_SSRF_PRIVATE_IP" } });
  });
  it.each(["http", "https"])("pins %s proxy sockets", async scheme => {
    const proxy = `${scheme}://proxy.test:4444`;
    await expect(safeFetch("https://target.test", {}, { proxy })).rejects.toMatchObject({ cause: { code: "ERR_SSRF_PRIVATE_IP" } });
    await proxyAgentFor(proxy).close();
  });
  it("propagates resolver options and errors", async () => {
    const resolver = vi.fn((_host, _opts, cb) => cb(Object.assign(new Error("DNS failed"), { code: "ENOTFOUND" }), []));
    await new Promise<void>(resolve => {
      (createSafeLookup(resolver) as Function)("a.test", { family: 6, hints: 32 }, (error: Error) => { expect(error.message).toBe("DNS failed"); resolve(); });
    });
    expect(resolver.mock.calls[0][1]).toEqual({ family: 6, hints: 32, all: true });
  });
});

describe("redirect policy", () => {
  it("rejects a private redirect before dispatch", async () => {
    const fetch = vi.fn(async () => new Response(null, { status: 302, headers: { location: "http://169.254.169.254/" } }));
    vi.stubGlobal("fetch", fetch);
    await expect(fetchWithSsrfProtection("http://8.8.8.8")).rejects.toThrow("private IP");
    expect(fetch).toHaveBeenCalledTimes(1);
  });
  it("blocks a rebinding redirect at the actual socket lookup", async () => {
    const transport = await vi.importActual<typeof import("undici")>("undici");
    let calls = 0;
    vi.stubGlobal("fetch", vi.fn(async (url, init) => {
      if (++calls === 1) return new Response(null, { status: 302, headers: { location: "https://rebind.test:444/" } });
      return transport.fetch(url, init);
    }));
    await expect(fetchWithSsrfProtection("https://8.8.8.8")).rejects.toMatchObject({ cause: { code: "ERR_SSRF_PRIVATE_IP" } });
    expect(calls).toBe(2);
  });
  it.each([301, 302, 303, 307, 308])("strips all connector secrets and the body across origins (%s)", async status => {
    const seen: RequestInit[] = [];
    vi.stubGlobal("fetch", vi.fn(async (_url, init) => {
      seen.push({ ...init, headers: new Headers(init.headers) });
      return seen.length === 1 ? new Response(null, { status, headers: { location: "https://8.8.4.4/next" } }) : new Response("ok");
    }));
    await fetchWithSsrfProtection("https://8.8.8.8", { method: "POST", body: "secret", headers: { Authorization: "s", Cookie: "s", "X-Api-Key": "s", "X-Connector-Token": "s", Accept: "text/plain", "User-Agent": "ff", "If-None-Match": "etag" } });
    expect([...new Headers(seen[1].headers).keys()]).toEqual(["accept", "if-none-match", "user-agent"]);
    expect(seen[1].body).toBeUndefined();
    expect(seen[1].method).toBe(status < 307 ? "GET" : "POST");
  });
});

describe("impit CONNECT bridge", () => {
  async function connect(proxyPort: number, path: string, auth?: string) {
    return new Promise<{ status: number; socket: net.Socket }>((resolve, reject) => {
      const req = http.request({ host: "127.0.0.1", port: proxyPort, method: "CONNECT", path, headers: auth ? { "Proxy-Authorization": auth } : {} });
      req.on("connect", (res, socket) => resolve({ status: res.statusCode!, socket }));
      req.on("error", reject); req.end();
    });
  }
  async function proxy(lookupFn?: net.LookupFunction, upstream?: string) {
    const { server } = await startEgressProxy("test-token", lookupFn, upstream);
    cleanup.push(() => new Promise<void>(resolve => server.close(() => resolve())));
    return (server.address() as net.AddressInfo).port;
  }
  const auth = `Basic ${Buffer.from("ff:test-token").toString("base64")}`;
  it("requires authentication and refuses private literal / DNS targets", async () => {
    const port = await proxy();
    for (const [target, token, status] of [["target.test:443", "wrong", 407], ["127.0.0.1:443", auth, 403], ["rebind.test:443", auth, 403]] as const) {
      const result = await connect(port, target, token); expect(result.status).toBe(status); result.socket.destroy();
    }
  });
  it("chains CONNECT through the admin upstream with proxy authentication", async () => {
    let path: string | undefined;
    let authorization: string | undefined;
    const upstream = http.createServer();
    const sockets = new Set<net.Socket>();
    upstream.on("connect", (req, socket) => {
      path = req.url;
      authorization = req.headers["proxy-authorization"];
      sockets.add(socket);
      socket.on("close", () => sockets.delete(socket));
      socket.write("HTTP/1.1 200 Connection Established\r\n\r\n");
    });
    const upstreamPort = await listen(upstream);
    cleanup.push(() => new Promise<void>(resolve => { for (const socket of sockets) socket.destroy(); upstream.close(() => resolve()); }));
    const port = await proxy(undefined, `http://admin:password@127.0.0.1:${upstreamPort}`);
    const result = await connect(port, "target.test:443", auth);
    expect(result.status).toBe(200);
    expect(path).toBe("target.test:443");
    expect(authorization).toBe(`Basic ${Buffer.from("admin:password").toString("base64")}`);
    result.socket.destroy();
  });
  it("tunnels TLS without rewriting hostname or SNI", async () => {
    let sni: string | undefined;
    const server = https.createServer({ key: readFileSync(new URL("../fixtures/tls/key.pem", import.meta.url)), cert: readFileSync(new URL("../fixtures/tls/cert.pem", import.meta.url)) }, (_req, res) => res.end("tunnel-ok"));
    server.on("secureConnection", socket => { sni = (socket as tls.TLSSocket & { servername: string }).servername; });
    const targetPort = await listen(server);
    cleanup.push(() => new Promise<void>(resolve => { server.closeAllConnections(); server.close(() => resolve()); }));
    // Controlled test connector routes the approved target to the local fixture.
    const localLookup = ((_h: string, _o: LookupOptions, cb: Function) => (_o.all ? cb(null, [{ address: "127.0.0.1", family: 4 }]) : cb(null, "127.0.0.1", 4))) as net.LookupFunction;
    const port = await proxy(localLookup);
    const result = await connect(port, `target.test:${targetPort}`, auth);
    expect(result.status).toBe(200);
    const socket = tls.connect({ socket: result.socket, servername: "target.test", rejectUnauthorized: false });
    const body = await new Promise<string>((resolve, reject) => {
      let body = ""; socket.on("data", chunk => { body += chunk; if (body.includes("tunnel-ok")) { socket.destroy(); resolve(body); } });
      socket.on("error", reject);
      socket.on("secureConnect", () => socket.write("GET / HTTP/1.1\r\nHost: target.test\r\nConnection: close\r\n\r\n"));
    });
    expect(body).toContain("tunnel-ok"); expect(sni).toBe("target.test");
    const { Impit } = await import("impit");
    const impit = new Impit({ browser: "chrome", proxyUrl: `http://ff:test-token@127.0.0.1:${port}`, ignoreTlsErrors: true });
    const response = await impit.fetch(`https://target.test:${targetPort}/`, { redirect: "manual" });
    expect(await response.text()).toBe("tunnel-ok");
    expect(sni).toBe("target.test");
  });
});

it("fails closed for unsupported admin upstreams before starting a listener", async () => {
  await expect(startEgressProxy("test", undefined, "socks5://localhost:1080")).rejects.toThrow("requires HTTP(S)");
});
