/** @type {import('next').NextConfig} */
const nextConfig = {
  output: "standalone",
  images: {
    unoptimized: true,
  },
  serverExternalPackages: [
    "jsdom",
    "isomorphic-dompurify",
    "@prisma/client",
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
          {
            key: "Content-Security-Policy",
            value: [
              "default-src 'self'",
              // Next.js requires unsafe-inline for runtime scripts and style injection
              "script-src 'self' 'unsafe-inline' 'unsafe-eval'",
              "style-src 'self' 'unsafe-inline'",
              // Allow data URIs and https images (feed favicons, article images)
              "img-src 'self' data: blob: https:",
              "font-src 'self' data:",
              // All API calls are same-origin; push service worker uses blob:
              "connect-src 'self'",
              // Service worker scope
              "worker-src 'self' blob:",
              // Replaces X-Frame-Options for modern browsers
              "frame-ancestors 'none'",
              "base-uri 'self'",
              "form-action 'self'",
            ].join("; "),
          },
        ],
      },
    ];
  },
};

export default nextConfig;
