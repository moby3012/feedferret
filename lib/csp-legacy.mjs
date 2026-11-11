// Shared by static assets and the runtime legacy rollback.
export const legacyCsp = [
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
].join("; ");
