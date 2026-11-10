"use client";

import { useEffect, useState } from "react";
import { useTranslations } from "next-intl";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { toast } from "sonner";

export function ApiPasswordSettings() {
  const t = useTranslations("apiPassword");
  const [password, setPassword] = useState("");
  const [currentPassword, setCurrentPassword] = useState("");
  const [shownSecret, setShownSecret] = useState("");
  const [required, setRequired] = useState(false);
  const [created, setCreated] = useState<string | null>(null);
  const [lastUsed, setLastUsed] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  async function load() {
    const response = await fetch("/api/user/api-password");
    if (!response.ok) return;
    const data = await response.json();
    setRequired(data.apiPasswordRequired); setCreated(data.apiPasswordCreatedAt); setLastUsed(data.apiPasswordLastUsedAt);
  }
  useEffect(() => { void load(); }, []);
  async function save(mode: "rotate" | "revoke" | "policy") {
    setBusy(true);
    try {
      const response = await fetch("/api/user/api-password", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ password, currentPassword, totp: currentPassword, required, revoke: mode === "revoke", policyOnly: mode === "policy" }) });
      if (!response.ok) {
        const error = await response.json().catch(() => ({}));
        toast.error(error.code === "reloginRequired" || error.code === "stepUpRequired" ? t(error.code) : t("failed"));
        return;
      }
      const result = await response.json();
      setShownSecret(result.password || ""); setCurrentPassword("");
      setPassword(""); await load(); toast.success(t("saved"));
    } catch { toast.error(t("failed")); } finally { setBusy(false); }
  }
  return <section className="rounded-2xl border border-border bg-card p-6 space-y-4">
    <h2 className="text-lg font-semibold tracking-title">{t("title")}</h2>
    <p className="text-sm text-muted-foreground">{t("description")}</p>
    <p className="text-sm text-muted-foreground">{t("passwordlessHint")}</p>
    <p className="text-sm">{created ? t("configured") : t("unconfigured")}{lastUsed ? ` · ${t("lastUsed", { date: new Date(lastUsed).toLocaleString() })}` : ""}</p>
    <label className="block text-sm" htmlFor="api-step-up">{t("stepUp")}</label>
    <Input id="api-step-up" type="password" autoComplete="current-password" value={currentPassword} onChange={(e) => setCurrentPassword(e.target.value)} />
    {shownSecret && <div role="status"><p>{t("shownOnce")}</p><code className="break-all select-all">{shownSecret}</code></div>}
    <label className="block text-sm" htmlFor="api-password">{t("password")}</label>
    <Input id="api-password" type="password" autoComplete="new-password" minLength={24} maxLength={72} value={password} onChange={(e) => setPassword(e.target.value)} />
    <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={required} onChange={(e) => setRequired(e.target.checked)} />{t("required")}</label>
    <div className="flex flex-wrap gap-2">
      <Button disabled={busy || (!!password && password.length < 24)} onClick={() => save("rotate")}>{t("rotate")}</Button>
      <Button variant="outline" disabled={busy} onClick={() => save("policy")}>{t("savePolicy")}</Button>
      <Button variant="destructive" disabled={busy || !created} onClick={() => save("revoke")}>{t("revoke")}</Button>
    </div>
  </section>;
}
