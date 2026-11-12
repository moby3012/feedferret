// Shared by static assets and the runtime legacy rollback.
export const legacyCsp = [
  "default-src 'self'",
  // Next.js requires unsafe-inline for runtime scripts and style injection
  "script-src 'self' 'unsafe-inline' 'unsafe-eval'",
  "style-src 'self' 'unsafe-inline'",
  // Allow data URIs and https images (feed favicons, article images)
  "img-src 'self' data: blob: https:",
  "media-src 'self' https: https://v.redd.it",
  "font-src 'self' data:",
  // All API calls are same-origin; push service worker uses blob:
  "connect-src 'self'",
  // Service worker scope
  "worker-src 'self' blob:",
  // Replaces X-Frame-Options for modern browsers
  "frame-src https://www.youtube-nocookie.com https://player.vimeo.com https://www.dailymotion.com https://player.twitch.tv https://clips.twitch.tv",
  "frame-ancestors 'none'",
  "base-uri 'self'",
  "form-action 'self'",
].join("; ");
