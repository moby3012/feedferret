import type { MetadataRoute } from "next";

export default function robots(): MetadataRoute.Robots {
  const base = (process.env.AUTH_URL ?? "http://localhost:3000").replace(/\/$/, "");

  return {
    rules: [
      {
        userAgent: "*",
        allow: ["/login", "/register", "/accessibility"],
        disallow: [
          "/",
          "/settings",
          "/manage-feeds",
          "/server-settings",
          "/api/",
          "/setup",
        ],
      },
    ],
    sitemap: `${base}/sitemap.xml`,
  };
}
