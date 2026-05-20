"use client";

import { useState, useEffect } from "react";
import Image from "next/image";
import { useRouter } from "next/navigation";
import { signIn } from "next-auth/react";
import { useTranslations } from "next-intl";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
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
      setError(e?.message || "Failed to save instance settings");
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
      setError(e?.message || "Failed to save email settings");
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
      setError(e?.message || "Failed to save security settings");
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
      setError(e?.message || "Import failed. You can add feeds manually after setup.");
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
    <div className="min-h-screen flex items-center justify-center p-4 sm:p-6 bg-black text-white selection:bg-zinc-800">
      <div className="w-full max-w-[520px] relative z-10">
        {/* Logo */}
        <div className="text-center mb-8 group">
          <div className="inline-flex items-center justify-center w-14 h-14 rounded-2xl border border-white/10 bg-zinc-900/50 p-3 mb-5 shadow-2xl">
            <Image src="/logo.svg" alt="FeedFerret" width={44} height={44} className="w-full h-full opacity-90" />
          </div>
          <h1 className="text-2xl font-bold tracking-tight text-white">
            Feed<span className="text-zinc-400">Ferret</span> Setup
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
                    ? "bg-white text-black border-white"
                    : stepIndex === i
                    ? "bg-white/10 text-white border-white/40"
                    : "bg-transparent text-zinc-600 border-zinc-800",
                )}
              >
                {stepIndex > i ? <Check className="w-4 h-4" /> : i + 1}
              </div>
              {i < visibleSteps.length - 1 && (
                <div className={cn("h-px w-8", stepIndex > i ? "bg-white/40" : "bg-zinc-800")} />
              )}
            </div>
          ))}
        </div>

        {/* Card */}
        <div className="rounded-3xl border border-white/10 bg-zinc-950/80 p-5 shadow-2xl ring-1 ring-white/5 backdrop-blur-xl sm:p-8">
          {error && (
            <div className="mb-5 p-3 rounded-xl bg-red-500/10 border border-red-500/20 text-red-400 text-xs font-medium">
              {error}
            </div>
          )}

          {/* ── Step 1: Account ── */}
          {step === "account" && (
            <div className="space-y-4">
              <div className="flex items-center gap-3 mb-6">
                <div className="flex h-10 w-10 items-center justify-center rounded-xl bg-white/10">
                  <UserPlus className="w-5 h-5" />
                </div>
                <div>
                  <h2 className="font-semibold text-white">{t("adminAccount")}</h2>
                  <p className="text-xs text-zinc-500">{t("adminAccountDescription")}</p>
                </div>
              </div>
              <Input
                placeholder={t("yourName")}
                className="bg-white/5 border-white/10 text-white placeholder:text-zinc-600 focus:border-white/20 h-11 rounded-xl"
                value={name}
                onChange={(e) => setName(e.target.value)}
                required
              />
              <Input
                type="email"
                placeholder={t("emailAddress")}
                className="bg-white/5 border-white/10 text-white placeholder:text-zinc-600 focus:border-white/20 h-11 rounded-xl"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                required
              />
              <Input
                type="password"
                placeholder={t("password")}
                className="bg-white/5 border-white/10 text-white placeholder:text-zinc-600 focus:border-white/20 h-11 rounded-xl"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                required
              />
              <Input
                type="password"
                placeholder={t("confirmPassword")}
                className="bg-white/5 border-white/10 text-white placeholder:text-zinc-600 focus:border-white/20 h-11 rounded-xl"
                value={confirmPassword}
                onChange={(e) => setConfirmPassword(e.target.value)}
                required
              />
              <Button
                onClick={handleCreateAccount}
                disabled={isLoading}
                className="w-full h-11 bg-white hover:bg-zinc-200 text-black font-semibold rounded-xl mt-2"
              >
                {isLoading ? (
                  <span className="flex items-center gap-2">
                    <div className="w-3 h-3 border-2 border-black/20 border-t-black rounded-full animate-spin" />
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
                <div className="flex h-10 w-10 items-center justify-center rounded-xl bg-white/10">
                  <Globe className="w-5 h-5" />
                </div>
                <div>
                  <h2 className="font-semibold text-white">{t("instanceSettings")}</h2>
                  <p className="text-xs text-zinc-500">{t("instanceSettingsDescription")}</p>
                </div>
              </div>
              <div className="space-y-2">
                <label htmlFor="setup-instance-name" className="text-xs text-zinc-400 font-medium">{t("instanceName")}</label>
                <Input
                  id="setup-instance-name"
                  placeholder="FeedFerret"
                  className="bg-white/5 border-white/10 text-white placeholder:text-zinc-600 focus:border-white/20 h-11 rounded-xl"
                  value={instanceName}
                  onChange={(e) => setInstanceName(e.target.value)}
                />
              </div>
              <div className="space-y-2">
                <label htmlFor="setup-instance-url" className="text-xs text-zinc-400 font-medium">{t("publicUrl")}</label>
                <Input
                  id="setup-instance-url"
                  placeholder="https://rss.example.com"
                  className="bg-white/5 border-white/10 text-white placeholder:text-zinc-600 focus:border-white/20 h-11 rounded-xl"
                  value={instanceUrl}
                  onChange={(e) => setInstanceUrl(e.target.value)}
                />
              </div>
              <div className="flex flex-col-reverse gap-3 pt-2 sm:flex-row">
                <Button variant="ghost" onClick={() => setStep("account")} className="h-11 rounded-xl text-zinc-400 hover:text-white">
                  <ArrowLeft className="w-4 h-4 me-1 rtl:rotate-180" /> {tCommon("back")}
                </Button>
                <Button onClick={handleSaveInstance} disabled={isLoading} className="flex-1 h-11 bg-white hover:bg-zinc-200 text-black font-semibold rounded-xl">
                  {isLoading ? <div className="w-3 h-3 border-2 border-black/20 border-t-black rounded-full animate-spin" /> : <span className="flex items-center gap-2">{t("continue")} <ArrowRight className="w-4 h-4" /></span>}
                </Button>
              </div>
            </div>
          )}

          {/* ── Step 3: Email ── */}
          {step === "email" && (
            <div className="space-y-4">
              <div className="flex items-center gap-3 mb-6">
                <div className="flex h-10 w-10 items-center justify-center rounded-xl bg-white/10">
                  <Mail className="w-5 h-5" />
                </div>
                <div>
                  <h2 className="font-semibold text-white">{t("emailDelivery")}</h2>
                  <p className="text-xs text-zinc-500">{t("emailDeliveryDescription")}</p>
                </div>
              </div>

              <div className="flex items-center justify-between p-4 rounded-xl bg-white/5 border border-white/10">
                <span className="text-sm text-zinc-300">{t("enableMailService")}</span>
                <button
                  onClick={() => setMailServiceEnabled(!mailServiceEnabled)}
                  aria-pressed={mailServiceEnabled}
                  aria-label="Toggle mail service"
                  className={cn(
                    "relative inline-flex h-6 w-11 items-center rounded-full transition-colors",
                    mailServiceEnabled ? "bg-white" : "bg-zinc-700",
                  )}
                >
                  <span className={cn("inline-block h-4 w-4 rounded-full bg-black shadow transition-transform", mailServiceEnabled ? "translate-x-6" : "translate-x-1")} />
                </button>
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
                            ? "bg-white text-black border-white"
                            : "bg-white/5 text-zinc-400 border-white/10 hover:border-white/30",
                        )}
                      >
                        {p === "smtp" ? t("smtp") : t("resend")}
                      </button>
                    ))}
                  </div>

                  {mailProvider === "smtp" && (
                    <>
                      <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
                        <Input placeholder={t("smtpHost")} className="bg-white/5 border-white/10 text-white placeholder:text-zinc-600 h-10 rounded-xl text-sm" value={smtpHost} onChange={(e) => setSmtpHost(e.target.value)} />
                        <Input placeholder={t("port")} type="number" className="bg-white/5 border-white/10 text-white placeholder:text-zinc-600 h-10 rounded-xl text-sm" value={smtpPort} onChange={(e) => setSmtpPort(e.target.value)} />
                      </div>
                      <Input placeholder={t("smtpUsername")} className="bg-white/5 border-white/10 text-white placeholder:text-zinc-600 h-10 rounded-xl text-sm" value={smtpUser} onChange={(e) => setSmtpUser(e.target.value)} />
                      <Input type="password" placeholder={t("smtpPassword")} className="bg-white/5 border-white/10 text-white placeholder:text-zinc-600 h-10 rounded-xl text-sm" value={smtpPassword} onChange={(e) => setSmtpPassword(e.target.value)} />
                      <Input placeholder={t("smtpFrom")} className="bg-white/5 border-white/10 text-white placeholder:text-zinc-600 h-10 rounded-xl text-sm" value={smtpFrom} onChange={(e) => setSmtpFrom(e.target.value)} />
                    </>
                  )}

                  {mailProvider === "resend" && (
                    <>
                      <Input type="password" placeholder={t("resendApiKey")} className="bg-white/5 border-white/10 text-white placeholder:text-zinc-600 h-10 rounded-xl text-sm" value={resendApiKey} onChange={(e) => setResendApiKey(e.target.value)} />
                      <Input placeholder={t("resendFromEmail")} className="bg-white/5 border-white/10 text-white placeholder:text-zinc-600 h-10 rounded-xl text-sm" value={resendFromEmail} onChange={(e) => setResendFromEmail(e.target.value)} />
                    </>
                  )}
                </>
              )}

              <div className="flex flex-col-reverse gap-3 pt-2 sm:flex-row">
                <Button variant="ghost" onClick={() => setStep("instance")} className="h-11 rounded-xl text-zinc-400 hover:text-white">
                  <ArrowLeft className="w-4 h-4 me-1 rtl:rotate-180" /> {tCommon("back")}
                </Button>
                <Button variant="ghost" onClick={() => handleSaveEmail(true)} className="h-11 rounded-xl text-zinc-500 hover:text-zinc-300 gap-1">
                  <SkipForward className="w-4 h-4" /> {t("skip")}
                </Button>
                <Button onClick={() => handleSaveEmail(false)} disabled={isLoading} className="flex-1 h-11 bg-white hover:bg-zinc-200 text-black font-semibold rounded-xl">
                  {isLoading ? <div className="w-3 h-3 border-2 border-black/20 border-t-black rounded-full animate-spin" /> : <span className="flex items-center gap-2">{t("continue")} <ArrowRight className="w-4 h-4" /></span>}
                </Button>
              </div>
            </div>
          )}

          {/* ── Step 4: Security ── */}
          {step === "security" && (
            <div className="space-y-4">
              <div className="flex items-center gap-3 mb-6">
                <div className="flex h-10 w-10 items-center justify-center rounded-xl bg-white/10">
                  <Lock className="w-5 h-5" />
                </div>
                <div>
                  <h2 className="font-semibold text-white">{t("accessControl")}</h2>
                  <p className="text-xs text-zinc-500">{t("accessControlDescription")}</p>
                </div>
              </div>

              <div className="p-5 rounded-xl bg-white/5 border border-white/10 space-y-3">
                <div className="flex items-start justify-between gap-4">
                  <div>
                    <p className="text-sm font-medium text-white">{t("allowPublicRegistration")}</p>
                    <p className="text-xs text-zinc-500 mt-1">
                      {t("allowPublicRegistrationDescription")}
                    </p>
                  </div>
                  <button
                    onClick={() => setRegistrationsEnabled(!registrationsEnabled)}
                    aria-pressed={registrationsEnabled}
                    aria-label="Toggle public registration"
                    className={cn(
                      "relative inline-flex h-6 w-11 shrink-0 items-center rounded-full transition-colors",
                      registrationsEnabled ? "bg-white" : "bg-zinc-700",
                    )}
                  >
                    <span className={cn("inline-block h-4 w-4 rounded-full bg-black shadow transition-transform", registrationsEnabled ? "translate-x-6" : "translate-x-1")} />
                  </button>
                </div>
              </div>

              <div className="p-4 rounded-xl border border-amber-500/20 bg-amber-500/5 text-amber-400 text-xs leading-relaxed">
                {t("twoFactorNote")}
              </div>

              <div className="flex flex-col-reverse gap-3 pt-2 sm:flex-row">
                <Button variant="ghost" onClick={() => setStep("email")} className="h-11 rounded-xl text-zinc-400 hover:text-white">
                  <ArrowLeft className="w-4 h-4 me-1 rtl:rotate-180" /> {tCommon("back")}
                </Button>
                <Button onClick={handleSaveSecurity} disabled={isLoading} className="flex-1 h-11 bg-white hover:bg-zinc-200 text-black font-semibold rounded-xl">
                  {isLoading ? <div className="w-3 h-3 border-2 border-black/20 border-t-black rounded-full animate-spin" /> : <span className="flex items-center gap-2">{t("continue")} <ArrowRight className="w-4 h-4" /></span>}
                </Button>
              </div>
            </div>
          )}

          {/* ── Step 5: Starter Packs ── */}
          {step === "starters" && (
            <div className="space-y-4">
              <div className="flex items-center gap-3 mb-6">
                <div className="flex h-10 w-10 items-center justify-center rounded-xl bg-white/10">
                  <Layers className="w-5 h-5" />
                </div>
                <div>
                  <h2 className="font-semibold text-white">{t("quickStart")}</h2>
                  <p className="text-xs text-zinc-500">{t("quickStartDescription")}</p>
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
                          ? "bg-white/10 border-white/30 text-white"
                          : "bg-white/5 border-white/10 text-zinc-400 hover:border-white/20 hover:text-zinc-300",
                      )}
                    >
                      <span className="text-base">{pack.emoji}</span>
                      <span className="flex-1">{pack.name}</span>
                      <span
                        className={cn(
                          "flex h-5 w-5 shrink-0 items-center justify-center rounded border transition-all",
                          selected ? "bg-white border-white" : "border-zinc-700",
                        )}
                      >
                        {selected && <Check className="w-3 h-3 text-black" />}
                      </span>
                    </button>
                  );
                })}
              </div>

              <p className="text-xs text-zinc-600 text-center">
                {selectedPacks.length === 0
                  ? t("nothingSelected")
                  : `${selectedPacks.length} ${selectedPacks.length === 1 ? t("packSelected") : t("packsSelected")}`}
              </p>

              <div className="flex flex-col-reverse gap-3 pt-2 sm:flex-row">
                <Button variant="ghost" onClick={() => setStep("security")} className="h-11 rounded-xl text-zinc-400 hover:text-white">
                  <ArrowLeft className="w-4 h-4 me-1 rtl:rotate-180" /> {tCommon("back")}
                </Button>
                <Button
                  variant="ghost"
                  onClick={() => { setSelectedPacks([]); router.push("/?addFeed=1"); }}
                  className="h-11 rounded-xl text-zinc-500 hover:text-zinc-300 gap-1"
                >
                  <SkipForward className="w-4 h-4" /> {t("skip")}
                </Button>
                <Button
                  onClick={handleImportStarters}
                  disabled={isLoading}
                  className="flex-1 h-11 bg-white hover:bg-zinc-200 text-black font-semibold rounded-xl"
                >
                  {isLoading ? (
                    <span className="flex items-center gap-2">
                      <div className="w-3 h-3 border-2 border-black/20 border-t-black rounded-full animate-spin" />
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
                <div className="flex h-16 w-16 items-center justify-center rounded-2xl bg-white/10 border border-white/20">
                  <Check className="w-8 h-8 text-white" />
                </div>
                <div>
                  <h2 className="text-xl font-bold text-white">{t("allSetTitle")}</h2>
                  <p className="text-zinc-400 text-sm mt-1">
                    {importedCount > 0
                      ? `${importedCount} ${t("feedsImported")}`
                      : t("instanceReady")}
                  </p>
                </div>
              </div>

              <div className="grid gap-2 text-start p-4 rounded-xl bg-white/5 border border-white/10 text-sm text-zinc-400">
                <p className="font-medium text-zinc-200">{t("nextSteps")}</p>
                <p>→ {t("addFeeds")}</p>
                <p>→ {t("enable2fa")}</p>
                <p>→ {t("setUpAlerts")}</p>
              </div>

              <Button
                onClick={() => router.push(importedCount > 0 ? "/" : "/?addFeed=1")}
                className="w-full h-12 bg-white hover:bg-zinc-200 text-black font-semibold rounded-xl text-base"
              >
                <Rss className="w-5 h-5 me-2" />
                {importedCount > 0 ? t("startReading") : t("addFirstFeed")}
              </Button>
            </div>
          )}
        </div>

        <p className="text-center text-zinc-700 text-[10px] font-medium tracking-[.15em] uppercase mt-8">
          FeedFerret · Self-hosted RSS
        </p>
      </div>
    </div>
  );
}
