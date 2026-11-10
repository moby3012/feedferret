import type { ReactNode } from "react";
import { FullMessagesProvider } from "@/i18n/full-messages-provider";

// This route's client components use namespaces the root layout leaves out (i18n/client-messages.ts).
export default function Layout({ children }: { children: ReactNode }) {
  return <FullMessagesProvider>{children}</FullMessagesProvider>;
}
