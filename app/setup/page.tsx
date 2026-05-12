"use client";

import { useState } from "react";
import Image from "next/image";
import { useRouter } from "next/navigation";
import { signIn } from "next-auth/react";
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
} from "lucide-react";

type Step = "account" | "instance" | "email" | "security" | "done";

const STEPS: Step[] = ["account", "instance", "email", "security", "done"];

const STEP_META: Record<Step, { title: string; description: string; icon: any }> = {
  account: { title: "Admin Account", description: "Create your administrator account", icon: ShieldCheck },
  instance: { title: "Instance Setup", description: "Configure your FeedFerret instance", icon: Server },
  email: { title: "Email", description: "Set up transactional email delivery", icon: Mail },
  security: { title: "Security", description: "Harden your installation", icon: Lock },
  done: { title: "You're set!", description: "Your hub is ready", icon: Rss },
};

export default function SetupPage() {
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

  const stepIndex = STEPS.indexOf(step);

  const handleCreateAccount = async () => {
    setError("");
    if (!name || !email || !password) {
      setError("All fields are required");
      return;
    }
    if (password !== confirmPassword) {
      setError("Passwords do not match");
      return;
    }
    if (password.length < 8) {
      setError("Password must be at least 8 characters");
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
        setError(data.message || "Account creation failed");
        return;
      }
      // Auto sign-in
      const signInRes = await signIn("credentials", {
        email,
        password,
        redirect: false,
      });
      if (signInRes?.error) {
        setError("Account created but auto sign-in failed. Please log in manually.");
        router.push("/login?setup=success");
        return;
      }
      setStep("instance");
    } catch {
      setError("Failed to connect to the server");
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
      setStep("done");
    } catch (e: any) {
      setError(e?.message || "Failed to save security settings");
    } finally {
      setIsLoading(false);
    }
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
          <p className="text-zinc-500 mt-1 text-sm font-medium tracking-tight">
            {STEP_META[step].description}
          </p>
        </div>

        {/* Step indicator */}
        <div className="flex items-center justify-center gap-2 mb-8">
          {STEPS.filter((s) => s !== "done").map((s, i) => (
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
              {i < STEPS.filter((s) => s !== "done").length - 1 && (
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
                  <h2 className="font-semibold text-white">Admin Account</h2>
                  <p className="text-xs text-zinc-500">First registered user becomes administrator</p>
                </div>
              </div>
              <Input
                placeholder="Your name"
                className="bg-white/5 border-white/10 text-white placeholder:text-zinc-600 focus:border-white/20 h-11 rounded-xl"
                value={name}
                onChange={(e) => setName(e.target.value)}
                required
              />
              <Input
                type="email"
                placeholder="Admin email"
                className="bg-white/5 border-white/10 text-white placeholder:text-zinc-600 focus:border-white/20 h-11 rounded-xl"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                required
              />
              <Input
                type="password"
                placeholder="Password (min. 8 chars)"
                className="bg-white/5 border-white/10 text-white placeholder:text-zinc-600 focus:border-white/20 h-11 rounded-xl"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                required
              />
              <Input
                type="password"
                placeholder="Confirm password"
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
                    Creating account…
                  </span>
                ) : (
                  <span className="flex items-center gap-2">
                    Continue <ArrowRight className="w-4 h-4" />
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
                  <h2 className="font-semibold text-white">Instance Settings</h2>
                  <p className="text-xs text-zinc-500">Used in emails and the onboarding wizard</p>
                </div>
              </div>
              <div className="space-y-2">
                <label className="text-xs text-zinc-400 font-medium">Instance Name</label>
                <Input
                  placeholder="FeedFerret"
                  className="bg-white/5 border-white/10 text-white placeholder:text-zinc-600 focus:border-white/20 h-11 rounded-xl"
                  value={instanceName}
                  onChange={(e) => setInstanceName(e.target.value)}
                />
              </div>
              <div className="space-y-2">
                <label className="text-xs text-zinc-400 font-medium">Public URL</label>
                <Input
                  placeholder="https://rss.example.com"
                  className="bg-white/5 border-white/10 text-white placeholder:text-zinc-600 focus:border-white/20 h-11 rounded-xl"
                  value={instanceUrl}
                  onChange={(e) => setInstanceUrl(e.target.value)}
                />
              </div>
              <div className="flex flex-col-reverse gap-3 pt-2 sm:flex-row">
                <Button variant="ghost" onClick={() => setStep("account")} className="h-11 rounded-xl text-zinc-400 hover:text-white">
                  <ArrowLeft className="w-4 h-4 mr-1" /> Back
                </Button>
                <Button onClick={handleSaveInstance} disabled={isLoading} className="flex-1 h-11 bg-white hover:bg-zinc-200 text-black font-semibold rounded-xl">
                  {isLoading ? <div className="w-3 h-3 border-2 border-black/20 border-t-black rounded-full animate-spin" /> : <span className="flex items-center gap-2">Continue <ArrowRight className="w-4 h-4" /></span>}
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
                  <h2 className="font-semibold text-white">Email Configuration</h2>
                  <p className="text-xs text-zinc-500">Required for magic links and digest emails</p>
                </div>
              </div>

              <div className="flex items-center justify-between p-4 rounded-xl bg-white/5 border border-white/10">
                <span className="text-sm text-zinc-300">Enable mail service</span>
                <button
                  onClick={() => setMailServiceEnabled(!mailServiceEnabled)}
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
                        {p === "smtp" ? "SMTP" : "Resend"}
                      </button>
                    ))}
                  </div>

                  {mailProvider === "smtp" && (
                    <>
                      <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
                        <Input placeholder="SMTP Host" className="bg-white/5 border-white/10 text-white placeholder:text-zinc-600 h-10 rounded-xl text-sm" value={smtpHost} onChange={(e) => setSmtpHost(e.target.value)} />
                        <Input placeholder="Port (587)" type="number" className="bg-white/5 border-white/10 text-white placeholder:text-zinc-600 h-10 rounded-xl text-sm" value={smtpPort} onChange={(e) => setSmtpPort(e.target.value)} />
                      </div>
                      <Input placeholder="SMTP Username" className="bg-white/5 border-white/10 text-white placeholder:text-zinc-600 h-10 rounded-xl text-sm" value={smtpUser} onChange={(e) => setSmtpUser(e.target.value)} />
                      <Input type="password" placeholder="SMTP Password" className="bg-white/5 border-white/10 text-white placeholder:text-zinc-600 h-10 rounded-xl text-sm" value={smtpPassword} onChange={(e) => setSmtpPassword(e.target.value)} />
                      <Input placeholder="From: noreply@example.com" className="bg-white/5 border-white/10 text-white placeholder:text-zinc-600 h-10 rounded-xl text-sm" value={smtpFrom} onChange={(e) => setSmtpFrom(e.target.value)} />
                    </>
                  )}

                  {mailProvider === "resend" && (
                    <>
                      <Input type="password" placeholder="Resend API Key (re_…)" className="bg-white/5 border-white/10 text-white placeholder:text-zinc-600 h-10 rounded-xl text-sm" value={resendApiKey} onChange={(e) => setResendApiKey(e.target.value)} />
                      <Input placeholder="From: Name <noreply@example.com>" className="bg-white/5 border-white/10 text-white placeholder:text-zinc-600 h-10 rounded-xl text-sm" value={resendFromEmail} onChange={(e) => setResendFromEmail(e.target.value)} />
                    </>
                  )}
                </>
              )}

              <div className="flex flex-col-reverse gap-3 pt-2 sm:flex-row">
                <Button variant="ghost" onClick={() => setStep("instance")} className="h-11 rounded-xl text-zinc-400 hover:text-white">
                  <ArrowLeft className="w-4 h-4 mr-1" /> Back
                </Button>
                <Button variant="ghost" onClick={() => handleSaveEmail(true)} className="h-11 rounded-xl text-zinc-500 hover:text-zinc-300 gap-1">
                  <SkipForward className="w-4 h-4" /> Skip
                </Button>
                <Button onClick={() => handleSaveEmail(false)} disabled={isLoading} className="flex-1 h-11 bg-white hover:bg-zinc-200 text-black font-semibold rounded-xl">
                  {isLoading ? <div className="w-3 h-3 border-2 border-black/20 border-t-black rounded-full animate-spin" /> : <span className="flex items-center gap-2">Continue <ArrowRight className="w-4 h-4" /></span>}
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
                  <h2 className="font-semibold text-white">Security</h2>
                  <p className="text-xs text-zinc-500">Harden your installation</p>
                </div>
              </div>

              <div className="p-5 rounded-xl bg-white/5 border border-white/10 space-y-3">
                <div className="flex items-start justify-between gap-4">
                  <div>
                    <p className="text-sm font-medium text-white">Allow public registration</p>
                    <p className="text-xs text-zinc-500 mt-1">
                      When off, only users provisioned via the internal API or admin can log in.
                      <strong className="text-zinc-400"> Recommended: off</strong> for private instances.
                    </p>
                  </div>
                  <button
                    onClick={() => setRegistrationsEnabled(!registrationsEnabled)}
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
                You can enable 2FA per-account in Settings after login. OAuth providers (Google, GitHub, Authelia) are configured via environment variables.
              </div>

              <div className="flex flex-col-reverse gap-3 pt-2 sm:flex-row">
                <Button variant="ghost" onClick={() => setStep("email")} className="h-11 rounded-xl text-zinc-400 hover:text-white">
                  <ArrowLeft className="w-4 h-4 mr-1" /> Back
                </Button>
                <Button onClick={handleSaveSecurity} disabled={isLoading} className="flex-1 h-11 bg-white hover:bg-zinc-200 text-black font-semibold rounded-xl">
                  {isLoading ? <div className="w-3 h-3 border-2 border-black/20 border-t-black rounded-full animate-spin" /> : <span className="flex items-center gap-2">Finish setup <ArrowRight className="w-4 h-4" /></span>}
                </Button>
              </div>
            </div>
          )}

          {/* ── Step 5: Done ── */}
          {step === "done" && (
            <div className="text-center space-y-6">
              <div className="flex flex-col items-center gap-4">
                <div className="flex h-16 w-16 items-center justify-center rounded-2xl bg-white/10 border border-white/20">
                  <Check className="w-8 h-8 text-white" />
                </div>
                <div>
                  <h2 className="text-xl font-bold text-white">Setup complete!</h2>
                  <p className="text-zinc-400 text-sm mt-1">Your FeedFerret instance is ready to use.</p>
                </div>
              </div>

              <div className="grid gap-2 text-left p-4 rounded-xl bg-white/5 border border-white/10 text-sm text-zinc-400">
                <p className="font-medium text-zinc-200">Next steps:</p>
                <p>→ Add your first RSS feeds</p>
                <p>→ Set up 2FA in Settings for extra security</p>
                <p>→ Configure Server Management for advanced options</p>
              </div>

              <Button
                onClick={() => router.push("/")}
                className="w-full h-12 bg-white hover:bg-zinc-200 text-black font-semibold rounded-xl text-base"
              >
                <Rss className="w-5 h-5 mr-2" />
                Go to FeedFerret
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
