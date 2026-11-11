import { redirect } from "next/navigation";

// N1: `/settings/newsletter` is the shareable name; the section lives in the settings shell.
export default function NewsletterSettingsPage() {
  redirect("/settings?tab=newsletter");
}
