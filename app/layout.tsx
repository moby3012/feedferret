import React from "react";
import type { Metadata, Viewport } from "next";
import { GeistSans } from "geist/font/sans";
import { GeistMono } from "geist/font/mono";
import { ThemeProvider } from "@/components/theme-provider";
import { ThemeColorApplier } from "@/components/theme-color-applier";
import { Providers } from "@/components/providers";
import { PwaInstallPrompt } from "@/components/pwa-install-prompt";
import { ServiceWorkerRegister } from "@/components/service-worker-register";
import { Toaster } from "@/components/ui/sonner";
import { SessionProvider } from "next-auth/react";
import { NextIntlClientProvider } from "next-intl";
import { getLocale, getMessages, getTranslations } from "next-intl/server";
import "./globals.css";
// KaTeX math rendering (M2 full-text polish): fonts + layout CSS only — it
// sets no colors of its own, inheriting from .article-content's already
// theme-aware text color, so no light/dark handling is needed here.
import "katex/dist/katex.min.css";
// Syntax-highlighting theme for fenced code blocks. A single dark theme is
// correct in both light and dark site modes: Tailwind Typography's prose
// styling already gives code blocks a fixed dark background regardless of
// overall theme (the conventional "code always looks like a terminal" look),
// so a light syntax theme would be unreadable on it in light mode too.
import "highlight.js/styles/atom-one-dark.css";

const APP_DESCRIPTION =
  "FeedFerret is a beautiful, self-hostable RSS reader. Follow any RSS, Atom or JSON feed, get AI summaries, keyword alerts, email digests and a full REST API — all on your own server.";

export const metadata: Metadata = {
  title: {
    default: "FeedFerret — Self-Hosted RSS Reader",
    template: "%s · FeedFerret",
  },
  description: APP_DESCRIPTION,
  metadataBase: new URL(process.env.AUTH_URL || "http://localhost:3000"),
  openGraph: {
    type: "website",
    siteName: "FeedFerret",
    title: "FeedFerret — Self-Hosted RSS Reader",
    description: APP_DESCRIPTION,
    images: [{ url: "/og-image.png", width: 1200, height: 630, alt: "FeedFerret — Self-Hosted RSS Reader" }],
  },
  twitter: {
    card: "summary_large_image",
    title: "FeedFerret — Self-Hosted RSS Reader",
    description: APP_DESCRIPTION,
    images: ["/og-image.png"],
  },
  manifest: "/manifest.json",
  appleWebApp: {
    capable: true,
    statusBarStyle: "default",
    title: "FeedFerret",
  },
  icons: {
    icon: [
      { url: "/favicon.ico", sizes: "any" },
      { url: "/icon-192.png", sizes: "192x192", type: "image/png" },
      { url: "/logo.svg", type: "image/svg+xml" },
    ],
    apple: [{ url: "/apple-touch-icon.png" }],
  },
};

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  viewportFit: "cover",
  themeColor: [
    { media: "(prefers-color-scheme: light)", color: "#f8f9fc" },
    { media: "(prefers-color-scheme: dark)", color: "#1a1b23" },
  ],
};

export default async function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  const locale = await getLocale();
  const t = await getTranslations("accessibility");
  const messages = await getMessages();

  return (
    <html lang={locale} className="bg-background" suppressHydrationWarning>
      <body className={`${GeistSans.variable} ${GeistMono.variable} font-sans antialiased`}>
        <a
          href="#main-content"
          className="sr-only focus:not-sr-only focus:fixed focus:top-4 focus:start-4 focus:z-[9999] focus:rounded-xl focus:bg-primary focus:px-4 focus:py-2 focus:text-sm focus:font-semibold focus:text-primary-foreground focus:shadow-lg focus:outline-none"
        >
          {t("skipToContent")}
        </a>
        <NextIntlClientProvider messages={messages}>
          <SessionProvider>
            <Providers>
              <ThemeProvider
                attribute="class"
                defaultTheme="system"
                enableSystem
                disableTransitionOnChange
              >
                <ThemeColorApplier />
                {children}
                <PwaInstallPrompt />
                <ServiceWorkerRegister />
                {/* Fixed mobile bottom bars (rss-header/mobile-bottom-controls,
                    article-reader) are h-16 with safe-area padding; keep toasts
                    clear of them on small screens (UX audit U-12). */}
                <Toaster
                  position="bottom-right"
                  mobileOffset={{ bottom: "calc(env(safe-area-inset-bottom) + 88px)" }}
                />
              </ThemeProvider>
            </Providers>
          </SessionProvider>
        </NextIntlClientProvider>
      </body>
    </html>
  );
}
