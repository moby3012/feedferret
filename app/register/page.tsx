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
    <div className="min-h-dvh flex items-center justify-center p-6 bg-background text-foreground selection:bg-muted">
      <div className="w-full max-w-[400px] relative z-(--z-sticky) animate-scale-in">
        <div className="text-center mb-10 group">
          {/* bg-accent, not bg-card: the logo mark is a solid white SVG with
              no dark variant, so it needs a background that's never
              near-white — bg-card is near-white in light mode and made the
              logo effectively invisible there. */}
          <div className="inline-flex items-center justify-center w-16 h-16 rounded-panel border border-border bg-accent p-3 mb-6 shadow-overlay transition-transform duration-(--dur-slow) group-hover:scale-105">
            <Image
              src="/logo.svg"
              alt="FeedFerret"
              width={40}
              height={40}
              className="w-full h-full opacity-90"
            />
          </div>
          <h1 className="text-headline font-bold tracking-title text-foreground">
            {t("subtitle")}
          </h1>
          <p className="text-muted-foreground mt-2 text-body-sm font-medium tracking-tight">
            {t("title")}
          </p>
        </div>

        <Card className="border-border bg-card backdrop-blur-bar shadow-overlay overflow-hidden ring-1 ring-border">
          <CardHeader className="pb-5 pt-8 px-8 text-center sm:text-start">
            <CardTitle className="text-title-sm font-semibold tracking-title text-foreground flex items-center justify-center sm:justify-start gap-2">
              <UserPlus className="w-4 h-4 text-muted-foreground" />
              {t("registration")}
            </CardTitle>
          </CardHeader>
          <CardContent className="px-8 pb-6">
            <form onSubmit={handleSubmit} className="space-y-4">
              <div className="relative group/input">
                <User className="absolute left-3.5 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground group-focus-within/input:text-foreground transition-colors" />
                <Input
                  placeholder={t("name")}
                  className="pl-10 bg-muted border-border text-foreground placeholder:text-muted-foreground transition-all h-11 rounded-panel text-body-sm focus-ring"
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  required
                />
              </div>
              <div className="relative group/input">
                <Mail className="absolute left-3.5 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground group-focus-within/input:text-foreground transition-colors" />
                <Input
                  type="email"
                  placeholder={t("email")}
                  className="pl-10 bg-muted border-border text-foreground placeholder:text-muted-foreground transition-all h-11 rounded-panel text-body-sm focus-ring"
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  required
                />
              </div>
              <div className="relative group/input">
                <Lock className="absolute left-3.5 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground group-focus-within/input:text-foreground transition-colors" />
                <Input
                  type="password"
                  placeholder={t("password")}
                  className="pl-10 bg-muted border-border text-foreground placeholder:text-muted-foreground transition-all h-11 rounded-panel text-body-sm focus-ring"
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  required
                />
              </div>
              <div className="relative group/input">
                <ShieldCheck className="absolute left-3.5 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground group-focus-within/input:text-foreground transition-colors" />
                <Input
                  type="password"
                  placeholder={t("confirmPassword")}
                  className="pl-10 bg-muted border-border text-foreground placeholder:text-muted-foreground transition-all h-11 rounded-panel text-body-sm focus-ring"
                  value={confirmPassword}
                  onChange={(e) => setConfirmPassword(e.target.value)}
                  required
                />
              </div>

              {error && (
                <div className="p-3 rounded-panel bg-danger/10 border border-danger/20 text-danger text-footnote font-medium animate-shake">
                  {error}
                </div>
              )}

              <Button
                type="submit"
                disabled={isLoading}
                className="w-full h-11 bg-foreground hover:bg-foreground/90 text-background font-semibold text-body-sm rounded-panel transition-all active:scale-95"
              >
                {isLoading ? (
                  <span className="flex items-center gap-2">
                    <div className="w-3 h-3 border-2 border-muted border-t-primary rounded-full animate-spin" />
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
          <CardFooter className="flex flex-col space-y-4 border-t border-border pt-6 pb-8 bg-muted/30">
            <div className="text-muted-foreground text-footnote font-medium text-center w-full">
              {t("alreadyHaveAccount")}{" "}
              <Link
                href="/login"
                className="text-foreground underline transition-all"
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
