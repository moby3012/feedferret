import { legacyCsp } from "./lib/csp-legacy.mjs";
import createNextIntlPlugin from 'next-intl/plugin';

// API responses are JSON, plus a few tiny server-rendered HTML pages (digest unsubscribe,
// Telegram callback, Auth.js sign-out/error) that only use inline styles and links.
const apiCsp = "default-src 'none'; style-src 'unsafe-inline'; img-src 'self' data: https:; form-action 'self'; frame-ancestors 'none'; base-uri 'none'";
// The offline shell: external script only (its retry handler lives in offline-reader.js);
// articles render in a sandboxed srcdoc iframe with its own meta CSP.
const offlineCsp = "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: https:; frame-src 'self' about:; object-src 'none'; frame-ancestors 'none'; base-uri 'self'; form-action 'self'";

const withNextIntl = createNextIntlPlugin('./i18n/request.ts');

/** @type {import('next').NextConfig} */
const nextConfig = {
  output: "standalone",
  images: {
    unoptimized: true,
  },
  serverExternalPackages: [
    "undici",
    "jsdom",
    "isomorphic-dompurify",
    "defuddle",
    "@mozilla/readability",
    "impit",
    "@prisma/client",
    "@prisma/adapter-better-sqlite3",
    "@prisma/adapter-pg",
    "@prisma/driver-adapter-utils",
    "better-sqlite3",
    "pg",
    "bcryptjs",
    "nodemailer",
  ],
  async headers() {
    return [
      {
        source: "/(.*)",
        headers: [
          // Prevent clickjacking — also set via CSP frame-ancestors below
          { key: "X-Frame-Options", value: "DENY" },
          // Prevent MIME-type sniffing
          { key: "X-Content-Type-Options", value: "nosniff" },
          // Limit referrer information sent to external sites
          { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
          // Disable unused browser features
          {
            key: "Permissions-Policy",
            value: "camera=(), microphone=(), geolocation=(), interest-cohort=()",
          },
          // Enforced everywhere (lib/csp-legacy.mjs), incl. the service worker script.
          { key: "Content-Security-Policy", value: legacyCsp },
        ],
      },
      // L3: the more specific policies below override the one above (for the same header
      // key the last matching entry wins). Pages additionally get the per-request nonce
      // policy as Content-Security-Policy-Report-Only from proxy.ts — see lib/csp.ts for
      // why the enforced header has to stay here. Baked in at build time.
      { source: "/api/:path*", headers: [{ key: "Content-Security-Policy", value: apiCsp }] },
      { source: "/api/media", headers: [
        { key: "Content-Security-Policy", value: "default-src 'none'" },
        { key: "Referrer-Policy", value: "no-referrer" },
      ] },
      { source: "/offline.html", headers: [{ key: "Content-Security-Policy", value: offlineCsp }] },
    ];
  },
};

export default withNextIntl(nextConfig);
