import React from "react";
import type { Metadata, Viewport } from "next";
import { fontVariables } from "./fonts";
import { ThemeProvider } from "@/components/theme-provider";
import { ThemeColorApplier } from "@/components/theme-color-applier";
import { THEME_COLOR } from "@/lib/theme-color";
import { Providers } from "@/components/providers";
import { PwaInstallPrompt } from "@/components/pwa-install-prompt";
import { ServiceWorkerRegister } from "@/components/service-worker-register";
import { TimezoneSync } from "@/components/timezone-sync";
import { Toaster } from "@/components/ui/sonner";
import { SessionProvider } from "next-auth/react";
import { NextIntlClientProvider } from "next-intl";
import { getLocale, getMessages, getTranslations } from "next-intl/server";
import { shellMessages } from "@/i18n/client-messages";
import { readingPreferencesFor } from "@/server/bootstrap";
import { currentSession } from "@/server/session";
import "./globals.css";
// KaTeX + highlight.js CSS live with the article body (components/reader/reader-body.tsx),
// out of the critical path of every page.

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
  // Soft keyboards resize the layout viewport instead of overlaying it, so
  // fixed bars follow the keyboard (--keyboard-inset is the iOS fallback).
  interactiveWidget: "resizes-content",
  // The bar surface (tokens.css --surface-bar-solid) so the status bar
  // continues the top bars; ThemeColorApplier follows a forced theme.
  themeColor: [
    { media: "(prefers-color-scheme: light)", color: THEME_COLOR.light },
    { media: "(prefers-color-scheme: dark)", color: THEME_COLOR.dark },
  ],
};

export default async function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  const [locale, t, messages, session] = await Promise.all([
    getLocale(),
    getTranslations("accessibility"),
    getMessages(),
    currentSession(),
  ]);
  // The session is known here: seeding SessionProvider with it saves the
  // client's /api/auth/session round trip(s) at boot (perf audit C1), and the
  // reading preferences seed ThemeColorApplier (shared with the reader page's
  // bootstrap through the request cache).
  const userId = session?.user?.id;
  const prefs = userId ? await readingPreferencesFor(userId) : null;

  return (
    <html lang={locale} dir={prefs?.layoutDirection} className="bg-background" suppressHydrationWarning>
      <body className={`${fontVariables} font-sans antialiased`}>
        <a
          href="#main-content"
          className="sr-only focus:not-sr-only focus:fixed focus:top-4 focus:start-4 focus:z-(--z-skip) focus:rounded-xl focus:bg-primary focus:px-4 focus:py-2 focus:text-sm focus:font-semibold focus:text-primary-foreground focus:shadow-lg focus:outline-none"
        >
          {t("skipToContent")}
        </a>
        <NextIntlClientProvider messages={shellMessages(messages)}>
          <SessionProvider session={session} refetchOnWindowFocus={false}>
            <Providers>
              <ThemeProvider
                attribute="class"
                defaultTheme="system"
                enableSystem
                disableTransitionOnChange
              >
                <ThemeColorApplier initialPrefs={prefs} />
                {children}
                <PwaInstallPrompt />
                <ServiceWorkerRegister />
                <TimezoneSync />
                {/* Fixed mobile bottom bars (rss-header/mobile-bottom-controls,
                    reader action pill) are h-16 with safe-area padding; keep toasts
                    clear of them on small screens (UX audit U-12). */}
                <Toaster
                  position="bottom-right"
                  mobileOffset={{ bottom: "calc(var(--safe-b) + 88px)" }}
                />
              </ThemeProvider>
            </Providers>
          </SessionProvider>
        </NextIntlClientProvider>
      </body>
    </html>
  );
}
