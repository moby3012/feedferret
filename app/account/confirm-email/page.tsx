import { getLocale } from "next-intl/server";
import { redirect } from "next/navigation";
import { consumeEmailChange } from "@/lib/email-change";
import { Button } from "@/components/ui/button";

export default async function ConfirmEmailPage({ searchParams }: { searchParams: Promise<{ t?: string; c?: string; result?: string }> }) {
  const params = await searchParams;
  const de = (await getLocale()) === "de";
  const token = params.c || params.t || "";
  const cancel = !!params.c;
  async function submit() {
    "use server";
    const result = await consumeEmailChange(token, cancel);
    redirect(`/account/confirm-email?result=${result}`);
  }
  const messages: Record<string, string> = de ? {
    confirmed: "E-Mail-Adresse bestätigt. Bitte melde dich erneut an.", cancelled: "Änderung abgebrochen.", invalid: "Dieser Link ist ungültig oder abgelaufen.", emailTaken: "Diese E-Mail-Adresse wird bereits verwendet.",
  } : {
    confirmed: "Email confirmed. Please sign in again.", cancelled: "Email change cancelled.", invalid: "This link is invalid or expired.", emailTaken: "This email address is already in use.",
  };
  return <main className="mx-auto max-w-lg space-y-6 p-6">
    <h1 className="text-title-sm font-semibold">{de ? "E-Mail-Adresse ändern" : "Change email address"}</h1>
    {params.result ? <p role="status">{messages[params.result] || messages.invalid}</p> :
      <form action={submit}><Button type="submit">{cancel ? (de ? "Änderung abbrechen" : "Cancel email change") : (de ? "E-Mail-Adresse bestätigen" : "Confirm email address")}</Button></form>}
    <a className="text-primary underline" href="/login">{de ? "Anmelden" : "Sign in"}</a>
  </main>;
}
