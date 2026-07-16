"use client";

import { useState, useEffect } from "react";
import Image from "next/image";
import { useRouter } from "next/navigation";
import { signIn } from "next-auth/react";
import { useTranslations } from "next-intl";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { cn } from "@/lib/utils";
import {
  ShieldCheck,
  Globe,
  Mail,
  Lock,
  ArrowRight,
  ArrowLeft,
  Check,
  UserPlus,
  Rss,
  Server,
  SkipForward,
  Layers,
} from "lucide-react";

type Step = "account" | "instance" | "email" | "security" | "starters" | "done";

const STEPS: Step[] = ["account", "instance", "email", "security", "starters", "done"];

const DEFAULT_STARTER_PACKS = [
  { id: "tech", name: "Technology", path: "tech.opml", emoji: "💻" },
  { id: "dev", name: "Developer News", path: "dev.opml", emoji: "🛠️" },
  { id: "science", name: "Science", path: "science.opml", emoji: "🔬" },
  { id: "news", name: "World News", path: "news.opml", emoji: "🌍" },
  { id: "design", name: "Design & UX", path: "design.opml", emoji: "🎨" },
];

export default function SetupPage() {
  const t = useTranslations("setup");
  const tCommon = useTranslations("common");
  const [step, setStep] = useState<Step>("account");
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState("");
  const router = useRouter();

  // Step 1 — Account
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");

  // Step 2 — Instance
  const [instanceName, setInstanceName] = useState("FeedFerret");
  const [instanceUrl, setInstanceUrl] = useState("");

  useEffect(() => {
    setInstanceUrl(window.location.origin);
  }, []);

  // Step 3 — Email
  const [mailProvider, setMailProvider] = useState("smtp");
  const [mailServiceEnabled, setMailServiceEnabled] = useState(false);
  const [smtpHost, setSmtpHost] = useState("");
  const [smtpPort, setSmtpPort] = useState("587");
  const [smtpUser, setSmtpUser] = useState("");
  const [smtpPassword, setSmtpPassword] = useState("");
  const [smtpFrom, setSmtpFrom] = useState("");
  const [resendApiKey, setResendApiKey] = useState("");
  const [resendFromEmail, setResendFromEmail] = useState("");

  // Step 4 — Security
  const [registrationsEnabled, setRegistrationsEnabled] = useState(false);

  // Step 5 — Starters
  const [selectedPacks, setSelectedPacks] = useState<string[]>(["tech", "dev"]);
  const [importedCount, setImportedCount] = useState(0);

  const stepIndex = STEPS.indexOf(step);
  const visibleSteps = STEPS.filter((s) => s !== "done");

  const handleCreateAccount = async () => {
    setError("");
    if (!name || !email || !password) {
      setError(t("errors.allFieldsRequired"));
      return;
    }
    if (password !== confirmPassword) {
      setError(t("errors.passwordsMismatch"));
      return;
    }
    if (password.length < 8) {
      setError(t("errors.passwordTooShort"));
      return;
    }
    setIsLoading(true);
    try {
      const res = await fetch("/api/register", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name, email, password }),
      });
      if (!res.ok) {
        const data = await res.json();
        setError(data.message || t("errors.accountCreationFailed"));
        return;
      }
      const signInRes = await signIn("credentials", {
        email,
        password,
        redirect: false,
      });
      if (signInRes?.error) {
        setError(t("errors.signInFailed"));
        router.push("/login?setup=success");
        return;
      }
      router.refresh();
      setStep("instance");
    } catch {
      setError(t("errors.networkError"));
    } finally {
      setIsLoading(false);
    }
  };

  const handleSaveInstance = async () => {
    setIsLoading(true);
    try {
      const { updateGlobalSettings } = await import("@/app/actions/admin");
      await updateGlobalSettings({ instanceName, instanceUrl, onboardingCompleted: false });
      setStep("email");
    } catch (e: any) {
      setError(e?.message || t("errors.instanceSaveFailed"));
    } finally {
      setIsLoading(false);
    }
  };

  const handleSaveEmail = async (skip = false) => {
    if (skip) {
      setStep("security");
      return;
    }
    setIsLoading(true);
    try {
      const { updateGlobalSettings } = await import("@/app/actions/admin");
      const data: Record<string, unknown> = { mailServiceEnabled };
      if (mailServiceEnabled) {
        data.mailProvider = mailProvider;
        if (mailProvider === "smtp") {
          data.smtpHost = smtpHost;
          data.smtpPort = parseInt(smtpPort) || 587;
          data.smtpUser = smtpUser;
          data.smtpPassword = smtpPassword;
          data.smtpFrom = smtpFrom;
        } else if (mailProvider === "resend") {
          data.resendApiKey = resendApiKey;
          data.resendFromEmail = resendFromEmail;
        }
      }
      await updateGlobalSettings(data);
      setStep("security");
    } catch (e: any) {
      setError(e?.message || t("errors.emailSaveFailed"));
    } finally {
      setIsLoading(false);
    }
  };

  const handleSaveSecurity = async () => {
    setIsLoading(true);
    try {
      const { updateGlobalSettings } = await import("@/app/actions/admin");
      await updateGlobalSettings({ registrationsEnabled, onboardingCompleted: true });
      setStep("starters");
    } catch (e: any) {
      setError(e?.message || t("errors.securitySaveFailed"));
    } finally {
      setIsLoading(false);
    }
  };

  const handleImportStarters = async () => {
    if (selectedPacks.length === 0) {
      router.push("/?addFeed=1");
      return;
    }
    setIsLoading(true);
    let total = 0;
    try {
      const { importOpml } = await import("@/app/actions/feeds");
      for (const packId of selectedPacks) {
        const pack = DEFAULT_STARTER_PACKS.find((p) => p.id === packId);
        if (!pack) continue;
        try {
          const res = await fetch(`/starter-opml/${pack.path}`);
          if (!res.ok) continue;
          const xml = await res.text();
          const result = await importOpml(xml);
          total += result.feedsAdded ?? 0;
        } catch {
          // continue with remaining packs
        }
      }
      setImportedCount(total);
      setStep("done");
    } catch (e: any) {
      setError(e?.message || t("errors.importFailed"));
      setStep("done");
    } finally {
      setIsLoading(false);
    }
  };

  const togglePack = (id: string) => {
    setSelectedPacks((prev) =>
      prev.includes(id) ? prev.filter((p) => p !== id) : [...prev, id],
    );
  };

  return (
    <div className="min-h-dvh flex items-center justify-center p-4 sm:p-6 bg-background text-foreground selection:bg-muted">
      <div className="w-full max-w-[520px] relative z-10">
        {/* Logo */}
        <div className="text-center mb-8 group">
          <div className="inline-flex items-center justify-center w-14 h-14 rounded-2xl border border-border bg-card p-3 mb-5 shadow-2xl">
            <Image src="/logo.svg" alt="FeedFerret" width={44} height={44} className="w-full h-full opacity-90" />
          </div>
          <h1 className="text-2xl font-bold tracking-[-0.04em] text-foreground">
            Feed<span className="text-muted-foreground">Ferret</span> Setup
          </h1>
        </div>

        {/* Step indicator */}
        <div className="flex items-center justify-center gap-2 mb-8">
          {visibleSteps.map((s, i) => (
            <div key={s} className="flex items-center gap-2">
              <div
                className={cn(
                  "flex items-center justify-center w-8 h-8 rounded-full text-xs font-bold border transition-all",
                  stepIndex > i
                    ? "bg-foreground text-background border-foreground"
                    : stepIndex === i
                    ? "bg-muted text-foreground border-ring"
                    : "bg-transparent text-muted-foreground border-border",
                )}
              >
                {stepIndex > i ? <Check className="w-4 h-4" /> : i + 1}
              </div>
              {i < visibleSteps.length - 1 && (
                <div className={cn("h-px w-8", stepIndex > i ? "bg-foreground/40" : "bg-border")} />
              )}
            </div>
          ))}
        </div>

        {/* Card */}
        <div className="rounded-3xl border border-border bg-card p-5 shadow-2xl ring-1 ring-border backdrop-blur-xl sm:p-8">
          {error && (
            <div className="mb-5 p-3 rounded-xl bg-red-500/10 border border-red-500/20 text-red-400 text-xs font-medium">
              {error}
            </div>
          )}

          {/* ── Step 1: Account ── */}
          {step === "account" && (
            <div className="space-y-4">
              <div className="flex items-center gap-3 mb-6">
                <div className="ui-brand-icon flex h-10 w-10 shrink-0 items-center justify-center rounded-2xl">
                  <UserPlus className="w-5 h-5" />
                </div>
                <div>
                  <h2 className="text-lg font-semibold tracking-[-0.02em] text-foreground">{t("adminAccount")}</h2>
                  <p className="text-xs text-muted-foreground">{t("adminAccountDescription")}</p>
                </div>
              </div>
              <Input
                placeholder={t("yourName")}
                className="bg-muted border-border text-foreground placeholder:text-muted-foreground focus:border-ring h-11 rounded-2xl"
                value={name}
                onChange={(e) => setName(e.target.value)}
                required
              />
              <Input
                type="email"
                placeholder={t("emailAddress")}
                className="bg-muted border-border text-foreground placeholder:text-muted-foreground focus:border-ring h-11 rounded-2xl"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                required
              />
              <Input
                type="password"
                placeholder={t("password")}
                className="bg-muted border-border text-foreground placeholder:text-muted-foreground focus:border-ring h-11 rounded-2xl"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                required
              />
              <Input
                type="password"
                placeholder={t("confirmPassword")}
                className="bg-muted border-border text-foreground placeholder:text-muted-foreground focus:border-ring h-11 rounded-2xl"
                value={confirmPassword}
                onChange={(e) => setConfirmPassword(e.target.value)}
                required
              />
              <Button
                onClick={handleCreateAccount}
                disabled={isLoading}
                className="w-full h-11 bg-foreground hover:bg-foreground/90 text-background font-semibold rounded-xl mt-2 active:scale-95"
              >
                {isLoading ? (
                  <span className="flex items-center gap-2">
                    <div className="w-3 h-3 border-2 border-muted border-t-primary rounded-full animate-spin" />
                    {t("creating")}
                  </span>
                ) : (
                  <span className="flex items-center gap-2">
                    {t("continue")} <ArrowRight className="w-4 h-4" />
                  </span>
                )}
              </Button>
            </div>
          )}

          {/* ── Step 2: Instance ── */}
          {step === "instance" && (
            <div className="space-y-4">
              <div className="flex items-center gap-3 mb-6">
                <div className="ui-brand-icon flex h-10 w-10 shrink-0 items-center justify-center rounded-2xl">
                  <Globe className="w-5 h-5" />
                </div>
                <div>
                  <h2 className="text-lg font-semibold tracking-[-0.02em] text-foreground">{t("instanceSettings")}</h2>
                  <p className="text-xs text-muted-foreground">{t("instanceSettingsDescription")}</p>
                </div>
              </div>
              <div className="space-y-2">
                <label htmlFor="setup-instance-name" className="text-xs text-muted-foreground font-medium">{t("instanceName")}</label>
                <Input
                  id="setup-instance-name"
                  placeholder="FeedFerret"
                  className="bg-muted border-border text-foreground placeholder:text-muted-foreground focus:border-ring h-11 rounded-2xl"
                  value={instanceName}
                  onChange={(e) => setInstanceName(e.target.value)}
                />
              </div>
              <div className="space-y-2">
                <label htmlFor="setup-instance-url" className="text-xs text-muted-foreground font-medium">{t("publicUrl")}</label>
                <Input
                  id="setup-instance-url"
                  placeholder="https://rss.example.com"
                  className="bg-muted border-border text-foreground placeholder:text-muted-foreground focus:border-ring h-11 rounded-2xl"
                  value={instanceUrl}
                  onChange={(e) => setInstanceUrl(e.target.value)}
                />
              </div>
              <div className="flex flex-col-reverse gap-3 pt-2 sm:flex-row">
                <Button variant="ghost" onClick={() => setStep("account")} className="h-11 rounded-xl text-muted-foreground hover:text-foreground">
                  <ArrowLeft className="w-4 h-4 me-1 rtl:rotate-180" /> {tCommon("back")}
                </Button>
                <Button onClick={handleSaveInstance} disabled={isLoading} className="flex-1 h-11 bg-foreground hover:bg-foreground/90 text-background font-semibold rounded-xl active:scale-95">
                  {isLoading ? <div className="w-3 h-3 border-2 border-muted border-t-primary rounded-full animate-spin" /> : <span className="flex items-center gap-2">{t("continue")} <ArrowRight className="w-4 h-4" /></span>}
                </Button>
              </div>
            </div>
          )}

          {/* ── Step 3: Email ── */}
          {step === "email" && (
            <div className="space-y-4">
              <div className="flex items-center gap-3 mb-6">
                <div className="ui-brand-icon flex h-10 w-10 shrink-0 items-center justify-center rounded-2xl">
                  <Mail className="w-5 h-5" />
                </div>
                <div>
                  <h2 className="text-lg font-semibold tracking-[-0.02em] text-foreground">{t("emailDelivery")}</h2>
                  <p className="text-xs text-muted-foreground">{t("emailDeliveryDescription")}</p>
                </div>
              </div>

              <div className="ui-control-surface flex items-center justify-between rounded-xl border p-4">
                <Label htmlFor="setup-mail-service-toggle" className="text-sm font-medium text-foreground/80 cursor-pointer">
                  {t("enableMailService")}
                </Label>
                <Switch
                  id="setup-mail-service-toggle"
                  checked={mailServiceEnabled}
                  onCheckedChange={setMailServiceEnabled}
                />
              </div>

              {mailServiceEnabled && (
                <>
                  <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
                    {["smtp", "resend"].map((p) => (
                      <button
                        key={p}
                        onClick={() => setMailProvider(p)}
                        className={cn(
                          "h-10 rounded-xl border text-sm font-medium transition-all",
                          mailProvider === p
                            ? "bg-foreground text-background border-foreground"
                            : "bg-muted text-muted-foreground border-border hover:border-ring",
                        )}
                      >
                        {p === "smtp" ? t("smtp") : t("resend")}
                      </button>
                    ))}
                  </div>

                  {mailProvider === "smtp" && (
                    <>
                      <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
                        <Input placeholder={t("smtpHost")} className="bg-muted border-border text-foreground placeholder:text-muted-foreground h-10 rounded-2xl text-sm" value={smtpHost} onChange={(e) => setSmtpHost(e.target.value)} />
                        <Input placeholder={t("port")} type="number" className="bg-muted border-border text-foreground placeholder:text-muted-foreground h-10 rounded-2xl text-sm" value={smtpPort} onChange={(e) => setSmtpPort(e.target.value)} />
                      </div>
                      <Input placeholder={t("smtpUsername")} className="bg-muted border-border text-foreground placeholder:text-muted-foreground h-10 rounded-2xl text-sm" value={smtpUser} onChange={(e) => setSmtpUser(e.target.value)} />
                      <Input type="password" placeholder={t("smtpPassword")} className="bg-muted border-border text-foreground placeholder:text-muted-foreground h-10 rounded-2xl text-sm" value={smtpPassword} onChange={(e) => setSmtpPassword(e.target.value)} />
                      <Input placeholder={t("smtpFrom")} className="bg-muted border-border text-foreground placeholder:text-muted-foreground h-10 rounded-2xl text-sm" value={smtpFrom} onChange={(e) => setSmtpFrom(e.target.value)} />
                    </>
                  )}

                  {mailProvider === "resend" && (
                    <>
                      <Input type="password" placeholder={t("resendApiKey")} className="bg-muted border-border text-foreground placeholder:text-muted-foreground h-10 rounded-2xl text-sm" value={resendApiKey} onChange={(e) => setResendApiKey(e.target.value)} />
                      <Input placeholder={t("resendFromEmail")} className="bg-muted border-border text-foreground placeholder:text-muted-foreground h-10 rounded-2xl text-sm" value={resendFromEmail} onChange={(e) => setResendFromEmail(e.target.value)} />
                    </>
                  )}
                </>
              )}

              <div className="flex flex-col-reverse gap-3 pt-2 sm:flex-row">
                <Button variant="ghost" onClick={() => setStep("instance")} className="h-11 rounded-xl text-muted-foreground hover:text-foreground">
                  <ArrowLeft className="w-4 h-4 me-1 rtl:rotate-180" /> {tCommon("back")}
                </Button>
                <Button variant="ghost" onClick={() => handleSaveEmail(true)} className="h-11 rounded-xl text-muted-foreground hover:text-foreground gap-1">
                  <SkipForward className="w-4 h-4" /> {t("skip")}
                </Button>
                <Button onClick={() => handleSaveEmail(false)} disabled={isLoading} className="flex-1 h-11 bg-foreground hover:bg-foreground/90 text-background font-semibold rounded-xl active:scale-95">
                  {isLoading ? <div className="w-3 h-3 border-2 border-muted border-t-primary rounded-full animate-spin" /> : <span className="flex items-center gap-2">{t("continue")} <ArrowRight className="w-4 h-4" /></span>}
                </Button>
              </div>
            </div>
          )}

          {/* ── Step 4: Security ── */}
          {step === "security" && (
            <div className="space-y-4">
              <div className="flex items-center gap-3 mb-6">
                <div className="ui-brand-icon flex h-10 w-10 shrink-0 items-center justify-center rounded-2xl">
                  <Lock className="w-5 h-5" />
                </div>
                <div>
                  <h2 className="text-lg font-semibold tracking-[-0.02em] text-foreground">{t("accessControl")}</h2>
                  <p className="text-xs text-muted-foreground">{t("accessControlDescription")}</p>
                </div>
              </div>

              <div className="ui-control-surface rounded-xl border p-5 space-y-3">
                <div className="flex items-start justify-between gap-4">
                  <div>
                    <Label htmlFor="setup-registrations-toggle" className="text-sm font-medium text-foreground cursor-pointer">
                      {t("allowPublicRegistration")}
                    </Label>
                    <p className="text-xs text-muted-foreground mt-1">
                      {t("allowPublicRegistrationDescription")}
                    </p>
                  </div>
                  <Switch
                    id="setup-registrations-toggle"
                    className="shrink-0"
                    checked={registrationsEnabled}
                    onCheckedChange={setRegistrationsEnabled}
                  />
                </div>
              </div>

              <div className="p-4 rounded-xl border border-amber-500/20 bg-amber-500/5 text-amber-400 text-xs leading-relaxed">
                {t("twoFactorNote")}
              </div>

              <div className="flex flex-col-reverse gap-3 pt-2 sm:flex-row">
                <Button variant="ghost" onClick={() => setStep("email")} className="h-11 rounded-xl text-muted-foreground hover:text-foreground">
                  <ArrowLeft className="w-4 h-4 me-1 rtl:rotate-180" /> {tCommon("back")}
                </Button>
                <Button onClick={handleSaveSecurity} disabled={isLoading} className="flex-1 h-11 bg-foreground hover:bg-foreground/90 text-background font-semibold rounded-xl active:scale-95">
                  {isLoading ? <div className="w-3 h-3 border-2 border-muted border-t-primary rounded-full animate-spin" /> : <span className="flex items-center gap-2">{t("continue")} <ArrowRight className="w-4 h-4" /></span>}
                </Button>
              </div>
            </div>
          )}

          {/* ── Step 5: Starter Packs ── */}
          {step === "starters" && (
            <div className="space-y-4">
              <div className="flex items-center gap-3 mb-6">
                <div className="ui-brand-icon flex h-10 w-10 shrink-0 items-center justify-center rounded-2xl">
                  <Layers className="w-5 h-5" />
                </div>
                <div>
                  <h2 className="text-lg font-semibold tracking-[-0.02em] text-foreground">{t("quickStart")}</h2>
                  <p className="text-xs text-muted-foreground">{t("quickStartDescription")}</p>
                </div>
              </div>

              <div className="space-y-2">
                {DEFAULT_STARTER_PACKS.map((pack) => {
                  const selected = selectedPacks.includes(pack.id);
                  return (
                    <button
                      key={pack.id}
                      onClick={() => togglePack(pack.id)}
                      className={cn(
                        "w-full flex items-center gap-3 px-4 py-3 rounded-xl border text-sm font-medium transition-all text-start",
                        selected
                          ? "bg-accent border-ring text-accent-foreground"
                          : "bg-muted border-border text-muted-foreground hover:border-ring hover:text-foreground",
                      )}
                    >
                      <span className="text-base">{pack.emoji}</span>
                      <span className="flex-1">{pack.name}</span>
                      <span
                        className={cn(
                          "flex h-5 w-5 shrink-0 items-center justify-center rounded border transition-all",
                          selected ? "bg-foreground border-foreground" : "border-border",
                        )}
                      >
                        {selected && <Check className="w-3 h-3 text-background" />}
                      </span>
                    </button>
                  );
                })}
              </div>

              <p className="text-xs text-muted-foreground text-center">
                {selectedPacks.length === 0
                  ? t("nothingSelected")
                  : t("packsSelected", { count: selectedPacks.length })}
              </p>

              <div className="flex flex-col-reverse gap-3 pt-2 sm:flex-row">
                <Button variant="ghost" onClick={() => setStep("security")} className="h-11 rounded-xl text-muted-foreground hover:text-foreground">
                  <ArrowLeft className="w-4 h-4 me-1 rtl:rotate-180" /> {tCommon("back")}
                </Button>
                <Button
                  variant="ghost"
                  onClick={() => { setSelectedPacks([]); router.push("/?addFeed=1"); }}
                  className="h-11 rounded-xl text-muted-foreground hover:text-foreground gap-1"
                >
                  <SkipForward className="w-4 h-4" /> {t("skip")}
                </Button>
                <Button
                  onClick={handleImportStarters}
                  disabled={isLoading}
                  className="flex-1 h-11 bg-foreground hover:bg-foreground/90 text-background font-semibold rounded-xl active:scale-95"
                >
                  {isLoading ? (
                    <span className="flex items-center gap-2">
                      <div className="w-3 h-3 border-2 border-muted border-t-primary rounded-full animate-spin" />
                      {t("importing")}
                    </span>
                  ) : (
                    <span className="flex items-center gap-2">
                      {selectedPacks.length === 0 ? t("addManually") : t("importAndStart")} <ArrowRight className="w-4 h-4" />
                    </span>
                  )}
                </Button>
              </div>
            </div>
          )}

          {/* ── Step 6: Done ── */}
          {step === "done" && (
            <div className="text-center space-y-6">
              <div className="flex flex-col items-center gap-4">
                <div className="ui-brand-icon flex h-16 w-16 items-center justify-center rounded-2xl">
                  <Check className="size-8" />
                </div>
                <div>
                  <h2 className="text-xl font-bold text-foreground">{t("allSetTitle")}</h2>
                  <p className="text-muted-foreground text-sm mt-1">
                    {importedCount > 0
                      ? `${importedCount} ${t("feedsImported")}`
                      : t("instanceReady")}
                  </p>
                </div>
              </div>

              <div className="grid gap-2 text-start p-4 rounded-xl bg-muted border border-border text-sm text-muted-foreground">
                <p className="font-medium text-foreground/90">{t("nextSteps")}</p>
                <p>→ {t("addFeeds")}</p>
                <p>→ {t("enable2fa")}</p>
                <p>→ {t("setUpAlerts")}</p>
              </div>

              <Button
                onClick={() => router.push(importedCount > 0 ? "/" : "/?addFeed=1")}
                className="w-full h-12 bg-foreground hover:bg-foreground/90 text-background font-semibold rounded-xl text-base active:scale-95"
              >
                <Rss className="w-5 h-5 me-2" />
                {importedCount > 0 ? t("startReading") : t("addFirstFeed")}
              </Button>
            </div>
          )}
        </div>

        <p className="text-center text-muted-foreground text-xs font-semibold uppercase tracking-wider mt-8">
          {t("tagline")}
        </p>
      </div>
    </div>
  );
}
