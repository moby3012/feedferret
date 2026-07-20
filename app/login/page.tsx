"use client";

import { useState, useEffect, type FormEvent } from "react";
import { useTranslations } from "next-intl";
import Image from "next/image";
import { signIn, useSession } from "next-auth/react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Card,
  CardHeader,
  CardTitle,
  CardContent,
  CardFooter,
} from "@/components/ui/card";
import Link from "next/link";
import { Mail, Lock, LogIn, Shield, Wand2 } from "lucide-react";
import { GithubIcon } from "@/components/icons/github-icon";
import { GoogleIcon } from "@/components/icons/google-icon";
import { hasUsers, getAuthProviders } from "../actions/onboarding";
import { Separator } from "@/components/ui/separator";
import { useInstance } from "@/hooks/use-instance";

export default function LoginPage() {
  const t = useTranslations("login");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [otp, setOtp] = useState("");
  const [showOtpField, setShowOtpField] = useState(false);
  const [error, setError] = useState("");
  const [errorIsWarning, setErrorIsWarning] = useState(false);
  const [isLoading, setIsLoading] = useState(false);
  const [providers, setProviders] = useState<{
    google: boolean;
    github: boolean;
    authelia: boolean;
    autheliaLabel: string;
  }>({ google: false, github: false, authelia: false, autheliaLabel: "Authelia" });
  const [magicLinkSending, setMagicLinkSending] = useState(false);
  const [magicLinkSent, setMagicLinkSent] = useState(false);
  const { data: instance } = useInstance();
  const magicLinkAvailable = Boolean(instance?.capabilities.magicLink);
  const registrationsEnabled = instance?.registrationsEnabled ?? true;
  const router = useRouter();
  const { status } = useSession();

  useEffect(() => {
    async function init() {
      if (status === "unauthenticated") {
        const usersExist = await hasUsers();
        if (!usersExist) {
          router.push("/setup");
        }
      }
      const enabledProviders = await getAuthProviders();
      setProviders(enabledProviders);
    }
    init();
  }, [status, router]);

  const handleSubmit = async (e: FormEvent) => {
    e.preventDefault();
    setError("");
    setErrorIsWarning(false);
    setIsLoading(true);

    try {
      if (!showOtpField) {
        // Only check if the account exists and whether 2FA is enabled.
        // Password is NOT verified here to prevent brute-force probing.
        const preflight = await fetch("/api/auth/credentials-status", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ email }),
        });

        if (!preflight.ok) {
          setError(t("errors.incorrectCredentials"));
          return;
        }

        const preflightData = await preflight.json();
        if (preflightData.requiresTwoFactor) {
          setShowOtpField(true);
          setErrorIsWarning(true);
          setError(t("errors.twoFactorRequired"));
          return;
        }
        // 2FA not enabled: fall through to signIn which verifies the password
      }

      const result = await signIn("credentials", {
        email,
        password,
        otp,
        redirect: false,
      });

      if (result?.error) {
        setErrorIsWarning(false);
        setError(showOtpField ? t("errors.passwordOrCodeIncorrect") : t("errors.incorrectCredentials"));
      } else {
        router.push("/");
        router.refresh();
      }
    } catch {
      setError(t("errors.unexpectedError"));
    } finally {
      setIsLoading(false);
    }
  };

  const handleOAuthSignIn = (provider: string) => {
    signIn(provider, { callbackUrl: "/" });
  };

  const handleMagicLink = async () => {
    if (!email.trim()) {
      setError(t("errors.enterEmailFirst"));
      setErrorIsWarning(false);
      return;
    }
    setError("");
    setErrorIsWarning(false);
    setMagicLinkSending(true);
    try {
      const result = await signIn("nodemailer", {
        email: email.trim(),
        redirect: false,
        callbackUrl: "/",
      });
      if (result?.error) {
        setError(t("errors.magicLinkFailed"));
      } else {
        setMagicLinkSent(true);
        setError(t("errors.magicLinkSent"));
        setErrorIsWarning(true);
      }
    } catch {
      setError(t("errors.magicLinkFailed"));
    } finally {
      setMagicLinkSending(false);
    }
  };

  if (status === "loading") return null;

  const hasOAuth = providers.google || providers.github || providers.authelia;

  return (
    <div className="min-h-dvh flex items-center justify-center p-4 bg-background text-foreground selection:bg-muted">
      <div className="w-full max-w-[400px] relative z-10 animate-scale-in">
        <div className="text-center mb-10 group">
          {/* bg-accent, not bg-card: the logo mark is a solid white SVG with
              no dark variant, so it needs a background that's never
              near-white — bg-card is near-white in light mode and made the
              logo effectively invisible there. */}
          <div className="inline-flex items-center justify-center w-16 h-16 rounded-2xl border border-border bg-accent p-3 mb-6 shadow-2xl transition-transform duration-500 group-hover:scale-105">
            <Image
              src="/logo.svg"
              alt="FeedFerret"
              width={40}
              height={40}
              className="w-full h-full opacity-90"
            />
          </div>
          <h1 className="text-2xl font-bold tracking-[-0.04em] text-foreground">
            Feed<span className="text-muted-foreground">Ferret</span>
          </h1>
          <p className="text-muted-foreground mt-2 text-sm font-medium tracking-tight">
            {t("tagline")}
          </p>
        </div>

        <Card className="border-border bg-card backdrop-blur-xl shadow-2xl overflow-hidden ring-1 ring-border">
          <CardHeader className="pb-5 pt-8 px-8 text-center sm:text-start">
            <CardTitle className="text-lg font-semibold tracking-[-0.02em] text-foreground flex items-center justify-center sm:justify-start gap-2">
              <LogIn className="w-4 h-4 text-muted-foreground" />
              {t("signIn")}
            </CardTitle>
          </CardHeader>
          <CardContent className="px-8 pb-6">
            <form onSubmit={handleSubmit} className="space-y-4">
              <div className="relative group/input">
                <Mail className="absolute left-3.5 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground transition-colors group-focus-within/input:text-foreground" />
                <Input
                  type="email"
                  placeholder={t("email")}
                  className="pl-10 bg-muted border-border text-foreground placeholder:text-muted-foreground focus:border-ring focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-0 transition-all h-11 rounded-2xl text-sm"
                  value={email}
                  onChange={(e) => {
                    setEmail(e.target.value);
                    setShowOtpField(false);
                    setOtp("");
                    setError("");
                    setErrorIsWarning(false);
                  }}
                  required
                />
              </div>
              <div className="relative group/input">
                <Lock className="absolute left-3.5 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground transition-colors group-focus-within/input:text-foreground" />
                <Input
                  type="password"
                  placeholder={t("password")}
                  className="pl-10 bg-muted border-border text-foreground placeholder:text-muted-foreground focus:border-ring focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-0 transition-all h-11 rounded-2xl text-sm"
                  value={password}
                  onChange={(e) => {
                    setPassword(e.target.value);
                    setShowOtpField(false);
                    setOtp("");
                    setError("");
                    setErrorIsWarning(false);
                  }}
                  required
                />
              </div>
              {showOtpField && (
                <div className="relative group/input">
                  <Shield className="absolute left-3.5 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground transition-colors group-focus-within/input:text-foreground" />
                  <Input
                    inputMode="numeric"
                    pattern="[0-9]*"
                    placeholder={t("authenticatorCode")}
                    className="pl-10 bg-muted border-border text-foreground placeholder:text-muted-foreground focus:border-ring focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-0 transition-all h-11 rounded-2xl text-sm"
                    value={otp}
                    onChange={(e) => setOtp(e.target.value.replace(/\D/g, "").slice(0, 6))}
                    autoFocus
                  />
                </div>
              )}

              {error && (
                <div
                  className={`p-3 rounded-2xl text-xs font-medium ${
                    errorIsWarning
                      ? "bg-yellow-500/10 border border-yellow-500/20 text-yellow-400"
                      : "bg-red-500/10 border border-red-500/20 text-red-400 animate-shake"
                  }`}
                >
                  {error}
                </div>
              )}

              <Button
                type="submit"
                disabled={isLoading}
                className="w-full h-11 bg-foreground hover:bg-foreground/90 text-background font-semibold text-sm rounded-2xl transition-all active:scale-95"
              >
                {isLoading ? (
                  <span className="flex items-center gap-2">
                    <div className="w-3 h-3 border-2 border-muted border-t-primary rounded-full animate-spin" />
                    {t("signingIn")}
                  </span>
                ) : (
                  t("continueWithEmail")
                )}
              </Button>

              {magicLinkAvailable && (
                <Button
                  type="button"
                  variant="outline"
                  disabled={magicLinkSending || magicLinkSent}
                  onClick={handleMagicLink}
                  className="w-full h-11 bg-muted border-border hover:bg-accent hover:text-accent-foreground text-foreground font-medium text-sm rounded-2xl transition-all"
                >
                  {magicLinkSending ? (
                    <span className="flex items-center gap-2">
                      <div className="w-3 h-3 border-2 border-foreground/20 border-t-foreground rounded-full animate-spin" />
                      {t("sendingLink")}
                    </span>
                  ) : magicLinkSent ? (
                    <span className="flex items-center gap-2">
                      <Mail className="w-4 h-4" />
                      {t("checkInbox")}
                    </span>
                  ) : (
                    <span className="flex items-center gap-2">
                      <Wand2 className="w-4 h-4" />
                      {t("sendMagicLink")}
                    </span>
                  )}
                </Button>
              )}
            </form>

            {hasOAuth && (
              <>
                <div className="relative my-6">
                  <div className="absolute inset-0 flex items-center">
                    <Separator className="w-full bg-border" />
                  </div>
                  <div className="relative flex justify-center text-xs uppercase">
                    <span className="bg-background px-2 text-muted-foreground font-medium">
                      {t("orContinueWith")}
                    </span>
                  </div>
                </div>

                <div className="grid gap-3 sm:grid-cols-2">
                  {providers.google && (
                    <Button
                      variant="outline"
                      className="bg-muted border-border hover:bg-accent hover:text-accent-foreground text-foreground h-11 rounded-2xl"
                      onClick={() => handleOAuthSignIn("google")}
                    >
                      <GoogleIcon className="w-4 h-4 me-2" />
                      Google
                    </Button>
                  )}
                  {providers.github && (
                    <Button
                      variant="outline"
                      className="bg-muted border-border hover:bg-accent hover:text-accent-foreground text-foreground h-11 rounded-2xl"
                      onClick={() => handleOAuthSignIn("github")}
                    >
                      <GithubIcon className="w-4 h-4 me-2" />
                      GitHub
                    </Button>
                  )}
                  {providers.authelia && (
                    <Button
                      variant="outline"
                      className="sm:col-span-2 bg-muted border-border hover:bg-accent hover:text-accent-foreground text-foreground h-11 rounded-2xl"
                      onClick={() => handleOAuthSignIn("authelia")}
                    >
                      <Shield className="w-4 h-4 me-2" />
                      {providers.autheliaLabel}
                    </Button>
                  )}
                </div>
              </>
            )}
          </CardContent>
          <CardFooter className="flex flex-col space-y-4 border-t border-border pt-6 pb-8 bg-muted/30">
            {registrationsEnabled ? (
              <div className="text-muted-foreground text-xs font-medium text-center w-full">
                {t("noAccountPrefix")}{" "}
                <Link
                  href="/register"
                  className="text-foreground underline transition-all"
                >
                  {t("createAccount")}
                </Link>
              </div>
            ) : (
              <div className="text-muted-foreground text-xs font-medium text-center w-full">
                {t("registrationsDisabled")}
              </div>
            )}
          </CardFooter>
        </Card>

        <div className="text-center mt-12 opacity-20">
          <p className="text-xs font-medium tracking-[0.2em] text-foreground uppercase">
            {t("privateSecureNewsFeed")}
          </p>
        </div>
      </div>
    </div>
  );
}
