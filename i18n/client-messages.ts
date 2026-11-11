import type { AbstractIntlMessages } from "next-intl";

/**
 * Message namespaces that only the settings, admin and onboarding routes (or
 * only the server) render. The root layout leaves them out of the client
 * provider — they were ~2/3 of the messages inlined into every HTML / RSC
 * payload (perf audit C15) — and those routes add them back with a nested
 * provider (`<FullMessagesProvider>` in their layout.tsx).
 *
 * Moving a component that uses one of these namespaces onto another route
 * means: drop the namespace from this list (or wrap that route too).
 */
export const ROUTE_ONLY_NAMESPACES = [
  // /settings (components/settings-form.tsx, api-password-settings.tsx)
  "settings",
  "profile",
  "twoFactor",
  "digest",
  "apiTokens",
  "ai",
  "contentFetch",
  "exportDestinations",
  "syncReaders",
  "deleteAccount",
  "settingsBookmarklet",
  "apiPassword",
  "newsletterSettings",
  // /manage-feeds (feed-management.tsx, feed-edit-dialog.tsx, freshrss-migration.tsx)
  "feedManagement",
  "feedEdit",
  // /server-settings (server-management-dialog.tsx)
  "serverManagement",
  "newsletterInbound", // components/newsletter/inbound-wizard.tsx (server-settings tab)
  // /setup
  "setup",
  // server only (e-mails)
  "emailDigest",
  "emailAuth",
] as const;

/** The messages every route's client components may use. */
export function shellMessages(messages: AbstractIntlMessages): AbstractIntlMessages {
  const out: AbstractIntlMessages = { ...messages };
  for (const ns of ROUTE_ONLY_NAMESPACES) delete out[ns];
  return out;
}
