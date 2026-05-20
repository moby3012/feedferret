"use client";

import { useState, useEffect } from "react";
import { useTranslations } from "next-intl";
import Image from "next/image";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Card,
  CardHeader,
  CardTitle,
  CardDescription,
  CardContent,
  CardFooter,
} from "@/components/ui/card";
import Link from "next/link";
import {
  UserPlus,
  Mail,
  Lock,
  User,
  ArrowRight,
  ShieldCheck,
} from "lucide-react";
import { useInstance } from "@/hooks/use-instance";

export default function RegisterPage() {
  const t = useTranslations("register");
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [error, setError] = useState("");
  const [isLoading, setIsLoading] = useState(false);
  const router = useRouter();
  const { data: instance, loading: instanceLoading } = useInstance();

  useEffect(() => {
    if (!instanceLoading && instance && !instance.registrationsEnabled) {
      router.replace("/login");
    }
  }, [instance, instanceLoading, router]);

  if (instanceLoading || (instance && !instance.registrationsEnabled)) {
    return null;
  }

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError("");

    if (password !== confirmPassword) {
      setError(t("errors.passwordsMismatch"));
      return;
    }

    setIsLoading(true);

    try {
      const response = await fetch("/api/register", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name, email, password }),
      });

      if (response.ok) {
        router.push("/login?registered=true");
      } else {
        const data = await response.json();
        setError(data.message || t("errors.somethingWentWrong"));
      }
    } catch (err) {
      setError(t("errors.failedToRegister"));
    } finally {
      setIsLoading(false);
    }
  };

  return (
    <div className="min-h-screen flex items-center justify-center p-6 bg-black text-white selection:bg-zinc-800">
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
            {t("subtitle")}
          </h1>
          <p className="text-zinc-500 mt-2 text-sm font-medium tracking-tight">
            {t("title")}
          </p>
        </div>

        <Card className="border-white/5 bg-zinc-950/50 backdrop-blur-xl shadow-2xl overflow-hidden ring-1 ring-white/10">
          <CardHeader className="pb-5 pt-8 px-8 text-center sm:text-left">
            <CardTitle className="text-lg font-semibold text-white flex items-center justify-center sm:justify-start gap-2">
              <UserPlus className="w-4 h-4 text-zinc-400" />
              {t("registration")}
            </CardTitle>
          </CardHeader>
          <CardContent className="px-8 pb-6">
            <form onSubmit={handleSubmit} className="space-y-4">
              <div className="relative group/input">
                <User className="absolute left-3.5 top-1/2 -translate-y-1/2 w-4 h-4 text-zinc-600 group-focus-within/input:text-white transition-colors" />
                <Input
                  placeholder={t("name")}
                  className="pl-10 bg-white/5 border-white/10 text-white placeholder:text-zinc-600 focus:border-white/20 focus:ring-0 transition-all h-11 rounded-lg text-sm"
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  required
                />
              </div>
              <div className="relative group/input">
                <Mail className="absolute left-3.5 top-1/2 -translate-y-1/2 w-4 h-4 text-zinc-600 group-focus-within/input:text-white transition-colors" />
                <Input
                  type="email"
                  placeholder={t("email")}
                  className="pl-10 bg-white/5 border-white/10 text-white placeholder:text-zinc-600 focus:border-white/20 focus:ring-0 transition-all h-11 rounded-lg text-sm"
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  required
                />
              </div>
              <div className="relative group/input">
                <Lock className="absolute left-3.5 top-1/2 -translate-y-1/2 w-4 h-4 text-zinc-600 group-focus-within/input:text-white transition-colors" />
                <Input
                  type="password"
                  placeholder={t("password")}
                  className="pl-10 bg-white/5 border-white/10 text-white placeholder:text-zinc-600 focus:border-white/20 focus:ring-0 transition-all h-11 rounded-lg text-sm"
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  required
                />
              </div>
              <div className="relative group/input">
                <ShieldCheck className="absolute left-3.5 top-1/2 -translate-y-1/2 w-4 h-4 text-zinc-600 group-focus-within/input:text-white transition-colors" />
                <Input
                  type="password"
                  placeholder={t("confirmPassword")}
                  className="pl-10 bg-white/5 border-white/10 text-white placeholder:text-zinc-600 focus:border-white/20 focus:ring-0 transition-all h-11 rounded-lg text-sm"
                  value={confirmPassword}
                  onChange={(e) => setConfirmPassword(e.target.value)}
                  required
                />
              </div>

              {error && (
                <div className="p-3 rounded-lg bg-red-500/10 border border-red-500/20 text-red-400 text-xs font-medium animate-shake">
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
                    {t("registering")}
                  </span>
                ) : (
                  <span className="flex items-center gap-2">
                    {t("register")}
                    <ArrowRight className="w-4 h-4" />
                  </span>
                )}
              </Button>
            </form>
          </CardContent>
          <CardFooter className="flex flex-col space-y-4 border-t border-white/5 pt-6 pb-8 bg-white/[0.02]">
            <div className="text-zinc-500 text-xs font-medium text-center w-full">
              {t("alreadyHaveAccount")}{" "}
              <Link
                href="/login"
                className="text-white hover:underline transition-all"
              >
                {t("signIn")}
              </Link>
            </div>
          </CardFooter>
        </Card>
      </div>
    </div>
  );
}
