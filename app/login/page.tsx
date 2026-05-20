"use client";

import { useState, useEffect } from "react";
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

  const handleSubmit = async (e: React.FormEvent) => {
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
          setError("Username or password incorrect");
          return;
        }

        const preflightData = await preflight.json();
        if (preflightData.requiresTwoFactor) {
          setShowOtpField(true);
          setErrorIsWarning(true);
          setError("2FA required — enter your authenticator code below");
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
        setError(showOtpField ? "Password or 2FA code is incorrect" : "Username or password incorrect");
      } else {
        router.push("/");
        router.refresh();
      }
    } catch {
      setError("An unexpected error occurred");
    } finally {
      setIsLoading(false);
    }
  };

  const handleOAuthSignIn = (provider: string) => {
    signIn(provider, { callbackUrl: "/" });
  };

  const handleMagicLink = async () => {
    if (!email.trim()) {
      setError("Enter your email address first");
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
        setError("Could not send magic link — check your email and try again");
      } else {
        setMagicLinkSent(true);
        setError("Sign-in link sent — check your inbox");
        setErrorIsWarning(true);
      }
    } catch {
      setError("Could not send magic link");
    } finally {
      setMagicLinkSending(false);
    }
  };

  if (status === "loading") return null;

  const hasOAuth = providers.google || providers.github || providers.authelia;

  return (
    <div className="min-h-screen flex items-center justify-center p-4 bg-black text-white selection:bg-zinc-800">
      <div className="w-full max-w-[400px] relative z-10 animate-scale-in">
        <div className="text-center mb-10 group">
          <div className="inline-flex items-center justify-center w-16 h-16 rounded-2xl border border-white/10 bg-zinc-900/50 p-3 mb-6 shadow-2xl transition-transform duration-500 group-hover:scale-105">
            <Image
              src="/logo.svg"
              alt="FeedFerret"
              width={40}
              height={40}
              className="w-full h-full opacity-90"
            />
          </div>
          <h1 className="text-2xl font-bold tracking-tight text-white">
            Feed<span className="text-zinc-400">Ferret</span>
          </h1>
          <p className="text-zinc-500 mt-2 text-sm font-medium tracking-tight">
            Minimalist RSS Aggregator
          </p>
        </div>

        <Card className="border-white/5 bg-zinc-950/50 backdrop-blur-xl shadow-2xl overflow-hidden ring-1 ring-white/10">
          <CardHeader className="pb-5 pt-8 px-8 text-center sm:text-start">
            <CardTitle className="text-lg font-semibold text-white flex items-center justify-center sm:justify-start gap-2">
              <LogIn className="w-4 h-4 text-zinc-400" />
              Sign In
            </CardTitle>
          </CardHeader>
          <CardContent className="px-8 pb-6">
            <form onSubmit={handleSubmit} className="space-y-4">
              <div className="relative group/input">
                <Mail className="absolute left-3.5 top-1/2 -translate-y-1/2 w-4 h-4 text-zinc-600 transition-colors group-focus-within/input:text-white" />
                <Input
                  type="email"
                  placeholder="Email"
                  className="pl-10 bg-white/5 border-white/10 text-white placeholder:text-zinc-600 focus:border-white/20 focus:ring-0 transition-all h-11 rounded-lg text-sm"
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
                <Lock className="absolute left-3.5 top-1/2 -translate-y-1/2 w-4 h-4 text-zinc-600 transition-colors group-focus-within/input:text-white" />
                <Input
                  type="password"
                  placeholder="Password"
                  className="pl-10 bg-white/5 border-white/10 text-white placeholder:text-zinc-600 focus:border-white/20 focus:ring-0 transition-all h-11 rounded-lg text-sm"
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
                  <Shield className="absolute left-3.5 top-1/2 -translate-y-1/2 w-4 h-4 text-zinc-600 transition-colors group-focus-within/input:text-white" />
                  <Input
                    inputMode="numeric"
                    pattern="[0-9]*"
                    placeholder="Authenticator code"
                    className="pl-10 bg-white/5 border-white/10 text-white placeholder:text-zinc-600 focus:border-white/20 focus:ring-0 transition-all h-11 rounded-lg text-sm"
                    value={otp}
                    onChange={(e) => setOtp(e.target.value.replace(/\D/g, "").slice(0, 6))}
                    autoFocus
                  />
                </div>
              )}

              {error && (
                <div
                  className={`p-3 rounded-lg text-xs font-medium ${
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
                className="w-full h-11 bg-white hover:bg-zinc-200 text-black font-semibold text-sm rounded-lg transition-all active:scale-[0.98]"
              >
                {isLoading ? (
                  <span className="flex items-center gap-2">
                    <div className="w-3 h-3 border-2 border-black/20 border-t-black rounded-full animate-spin" />
                    Signing in...
                  </span>
                ) : (
                  "Continue with Email"
                )}
              </Button>

              {magicLinkAvailable && (
                <Button
                  type="button"
                  variant="outline"
                  disabled={magicLinkSending || magicLinkSent}
                  onClick={handleMagicLink}
                  className="w-full h-11 bg-white/5 border-white/10 hover:bg-white/10 text-white font-medium text-sm rounded-lg transition-all"
                >
                  {magicLinkSending ? (
                    <span className="flex items-center gap-2">
                      <div className="w-3 h-3 border-2 border-white/20 border-t-white rounded-full animate-spin" />
                      Sending link…
                    </span>
                  ) : magicLinkSent ? (
                    <span className="flex items-center gap-2">
                      <Mail className="w-4 h-4" />
                      Check your inbox
                    </span>
                  ) : (
                    <span className="flex items-center gap-2">
                      <Wand2 className="w-4 h-4" />
                      Send me a magic link
                    </span>
                  )}
                </Button>
              )}
            </form>

            {hasOAuth && (
              <>
                <div className="relative my-6">
                  <div className="absolute inset-0 flex items-center">
                    <Separator className="w-full bg-white/10" />
                  </div>
                  <div className="relative flex justify-center text-xs uppercase">
                    <span className="bg-[#0c0c0e] px-2 text-zinc-500 font-medium">
                      Or continue with
                    </span>
                  </div>
                </div>

                <div className="grid gap-3 sm:grid-cols-2">
                  {providers.google && (
                    <Button
                      variant="outline"
                      className="bg-white/5 border-white/10 hover:bg-white/10 text-white h-11 rounded-lg"
                      onClick={() => handleOAuthSignIn("google")}
                    >
                      <GoogleIcon className="w-4 h-4 me-2" />
                      Google
                    </Button>
                  )}
                  {providers.github && (
                    <Button
                      variant="outline"
                      className="bg-white/5 border-white/10 hover:bg-white/10 text-white h-11 rounded-lg"
                      onClick={() => handleOAuthSignIn("github")}
                    >
                      <GithubIcon className="w-4 h-4 me-2" />
                      GitHub
                    </Button>
                  )}
                  {providers.authelia && (
                    <Button
                      variant="outline"
                      className="sm:col-span-2 bg-white/5 border-white/10 hover:bg-white/10 text-white h-11 rounded-lg"
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
          <CardFooter className="flex flex-col space-y-4 border-t border-white/5 pt-6 pb-8 bg-white/[0.02]">
            {registrationsEnabled ? (
              <div className="text-zinc-500 text-xs font-medium text-center w-full">
                Don&apos;t have an account?{" "}
                <Link
                  href="/register"
                  className="text-white hover:underline transition-all"
                >
                  Create one
                </Link>
              </div>
            ) : (
              <div className="text-zinc-600 text-xs font-medium text-center w-full">
                Registrations are currently disabled on this instance.
              </div>
            )}
          </CardFooter>
        </Card>

        <div className="text-center mt-12 opacity-20">
          <p className="text-[10px] font-medium tracking-[0.2em] text-white uppercase">
            Private & Secure News Feed
          </p>
        </div>
      </div>
    </div>
  );
}
