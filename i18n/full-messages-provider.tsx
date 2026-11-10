import type { ReactNode } from "react";
import { NextIntlClientProvider } from "next-intl";
import { getMessages } from "next-intl/server";

/** All messages for the routes whose client components use the ROUTE_ONLY_NAMESPACES (i18n/client-messages.ts). */
export async function FullMessagesProvider({ children }: { children: ReactNode }) {
  const messages = await getMessages();
  return <NextIntlClientProvider messages={messages}>{children}</NextIntlClientProvider>;
}
