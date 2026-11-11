import http from "node:http";
import https from "node:https";
import net from "node:net";
import { randomBytes } from "node:crypto";
import type { LookupFunction } from "node:net";
import { safeLookup } from "./safe-dispatcher";
import { isPrivateIp } from "./private-ip";

/** Authenticated loopback CONNECT bridge; TLS and SNI remain end-to-end. */
export async function startEgressProxy(token: string, lookup: LookupFunction = safeLookup, upstream?: string) {
  const proxy = upstream ? new URL(upstream) : null;
  if (proxy && !["http:", "https:"].includes(proxy.protocol)) throw new Error("Egress proxy requires HTTP(S)");
  const proxyAuth = proxy?.username
    ? `Basic ${Buffer.from(`${decodeURIComponent(proxy.username)}:${decodeURIComponent(proxy.password)}`).toString("base64")}`
    : undefined;
  const authorization = `Basic ${Buffer.from(`ff:${token}`).toString("base64")}`;
  const server = http.createServer((_req, res) => { res.writeHead(405).end(); });
  server.on("connect", (req, client, head) => {
    client.on("error", () => client.destroy());
    if (req.headers["proxy-authorization"] !== authorization) {
      client.end("HTTP/1.1 407 Proxy Authentication Required\r\n\r\n"); return;
    }
    let target: URL;
    try {
      target = new URL(`https://${req.url}`);
      if (!req.url?.match(/:\d+$/) || target.username || target.password || target.pathname !== "/" || target.search || target.hash) throw new Error("authority required");
    } catch { client.end("HTTP/1.1 400 Bad Request\r\n\r\n"); return; }
    const hostname = target.hostname.replace(/^\[|\]$/g, "");
    const reject = () => client.end("HTTP/1.1 403 Forbidden\r\n\r\n");
    const pipe = (socket: net.Socket, buffered = Buffer.alloc(0)) => {
      if (client.destroyed) { socket.destroy(); return; }
      client.write("HTTP/1.1 200 Connection Established\r\n\r\n");
      if (buffered.length) client.write(buffered);
      if (head.length) socket.write(head);
      socket.pipe(client); client.pipe(socket);
      client.on("close", () => socket.destroy());
      client.on("end", () => socket.destroy());
      socket.on("error", () => client.destroy());
      socket.on("close", () => client.destroy());
      socket.setTimeout(30_000, () => socket.destroy());
    };
    // Admin-configured egress resolves the target remotely. It is the trust boundary.
    if (proxy) {
      const request = (proxy.protocol === "https:" ? https : http).request(proxy, {
        method: "CONNECT", path: `${target.hostname}:${target.port || 443}`, timeout: 30_000,
        headers: { host: target.host, ...(proxyAuth ? { "Proxy-Authorization": proxyAuth } : {}) },
      });
      request.on("connect", (res, socket, buffered) => res.statusCode === 200 ? pipe(socket, buffered) : (socket.destroy(), reject()));
      request.on("response", res => { res.destroy(); reject(); });
      request.on("error", reject);
      request.on("timeout", () => { reject(); request.destroy(); });
      client.on("close", () => request.destroy());
      client.on("end", () => request.destroy());
      request.end();
      return;
    }
    if (net.isIP(hostname) && isPrivateIp(hostname)) { reject(); return; }
    const socket = net.connect({ host: hostname, port: Number(target.port || 443), lookup });
    socket.once("connect", () => pipe(socket));
    socket.once("error", reject);
    client.on("close", () => socket.destroy());
      client.on("end", () => socket.destroy());
    socket.setTimeout(30_000, () => { reject(); socket.destroy(); });
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => { server.off("error", reject); resolve(); });
  });
  server.unref();
  return { server, url: `http://ff:${token}@127.0.0.1:${(server.address() as net.AddressInfo).port}` };
}
let singleton: ReturnType<typeof startEgressProxy> | undefined;
export function getEgressProxy(upstream?: string) {
  return singleton ??= startEgressProxy(randomBytes(32).toString("hex"), safeLookup, upstream);
}
