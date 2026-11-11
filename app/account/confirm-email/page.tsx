import { getTranslations } from "next-intl/server";
import { Button } from "@/components/ui/button";
import { submitEmailChange } from "./actions";

export default async function ConfirmEmailPage({ searchParams }: { searchParams: Promise<{ t?: string; c?: string; result?: string }> }) {
  const params = await searchParams;
  const t = await getTranslations("emailChangeConfirm");
  const token = typeof params.c === "string" ? params.c : typeof params.t === "string" ? params.t : "";
  const cancel = typeof params.c === "string";
  const result = params.result === "confirmed" || params.result === "cancelled" ? params.result : "invalid";
  return <main className="mx-auto max-w-lg space-y-6 p-6">
    <h1 className="text-title-sm font-semibold">{t("title")}</h1>
    {params.result ? <p role="status">{t(result)}</p> :
      <form action={submitEmailChange}>
        <input type="hidden" name="token" value={token} />
        <input type="hidden" name="intent" value={cancel ? "cancel" : "confirm"} />
        <Button type="submit">{t(cancel ? "cancel" : "confirm")}</Button>
      </form>}
    <a className="text-primary underline" href="/login">{t("signIn")}</a>
  </main>;
}
