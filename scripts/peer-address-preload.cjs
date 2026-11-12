// Preloaded into the production server (`node --require … server.js`, see start.sh).
//
// Next.js route handlers only see a Fetch `Request`, not the TCP socket, so the direct peer address is
// invisible to them. This stamps it on every incoming request as `x-feedferret-peer: <token>|<address>`,
// overwriting any value the client sent. The token is random per process and only known to this process
// (and children inheriting the environment): lib/client-ip.ts ignores the header without it, so a client
// cannot forge a peer address, and nothing changes where this file is not loaded (next dev, tests).
// Only node:http Server request events are stamped here; https.Server and
// upgrade events are not stamped. Production terminates TLS at the reverse proxy.
"use strict";
const http = require("node:http");
const crypto = require("node:crypto");

const token = crypto.randomBytes(24).toString("hex");
process.env.FEEDFERRET_PEER_TOKEN = token;

const originalEmit = http.Server.prototype.emit;
http.Server.prototype.emit = function emit(event, req, ...rest) {
  if ((event === "request" || event === "checkContinue" || event === "checkExpectation") && req && req.headers) {
    req.headers["x-feedferret-peer"] = `${token}|${(req.socket && req.socket.remoteAddress) || ""}`;
  }
  return originalEmit.call(this, event, req, ...rest);
};
