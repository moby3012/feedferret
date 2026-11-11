"use server";

import { redirect } from "next/navigation";
import { consumeEmailChange } from "@/lib/email-change";

export async function submitEmailChange(formData: FormData) {
  let result: "confirmed" | "cancelled" | "invalid" = "invalid";
  try {
    const token = formData.get("token");
    const intent = formData.get("intent");
    if (typeof token === "string" && (intent === "confirm" || intent === "cancel")) {
      const outcome = await consumeEmailChange(token, intent === "cancel");
      if (outcome === "confirmed" || outcome === "cancelled") result = outcome;
    }
  } catch {
    // Never expose database/transport errors or token material on this public page.
  }
  redirect(`/account/confirm-email?result=${result}`);
}
