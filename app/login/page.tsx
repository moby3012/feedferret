"use client";

import { useState, useEffect } from "react";
import { signIn, useSession } from "next-auth/react";
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
import { Mail, Lock, ArrowRight, LogIn, Sparkles } from "lucide-react";
import { hasUsers } from "../actions/onboarding";

export default function LoginPage() {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [isLoading, setIsLoading] = useState(false);
  const router = useRouter();
  const { status } = useSession();

  useEffect(() => {
    async function checkFirstRun() {
      if (status === "unauthenticated") {
        const usersExist = await hasUsers();
        if (!usersExist) {
          router.push("/setup");
        }
      }
    }
    checkFirstRun();
  }, [status, router]);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError("");
    setIsLoading(true);

    try {
      const result = await signIn("credentials", {
        email,
        password,
        redirect: false,
      });

      if (result?.error) {
        setError("Invalid email or password");
      } else {
        router.push("/");
        router.refresh();
      }
    } catch (err) {
      setError("An unexpected error occurred");
    } finally {
      setIsLoading(false);
    }
  };

  if (status === "loading") return null;

  return (
    <div className="min-h-screen flex items-center justify-center p-4 bg-[#05060a] relative overflow-hidden text-white selection:bg-blue-500/30">
      {/* Background Orbs */}
      <div className="absolute top-[-10%] right-[-10%] w-[50%] h-[50%] bg-blue-600/10 rounded-full blur-[120px] animate-pulse" />
      <div className="absolute bottom-[-10%] left-[-10%] w-[50%] h-[50%] bg-indigo-600/10 rounded-full blur-[120px] animate-pulse delay-700" />

      <div className="w-full max-w-[400px] relative z-10 animate-scale-in">
        <div className="text-center mb-8 group">
          <div className="inline-flex items-center justify-center w-16 h-16 rounded-2xl bg-gradient-to-br from-blue-500 to-indigo-600 p-[1px] mb-5 shadow-2xl shadow-blue-500/40 transition-transform duration-500 group-hover:scale-105">
            <div className="w-full h-full bg-[#05060a] rounded-[15px] flex items-center justify-center overflow-hidden">
              <img
                src="/logo.svg"
                alt="FeedFerret"
                className="w-10 h-10 invert brightness-200"
              />
            </div>
          </div>
          <h1 className="text-3xl font-black tracking-tighter text-white drop-shadow-sm">
            Welcome to Feed<span className="text-blue-500">Ferret</span>
          </h1>
          <p className="text-zinc-500 mt-1 text-sm font-medium tracking-wide flex items-center justify-center gap-2">
            <Sparkles className="w-3.5 h-3.5 text-blue-400" />
            Your News Hub
          </p>
        </div>

        <Card className="border-white/5 bg-white/[0.02] backdrop-blur-3xl shadow-[0_32px_64px_-12px_rgba(0,0,0,0.6)] overflow-hidden ring-1 ring-white/10">
          <CardHeader className="pb-5 pt-8 px-8 text-center sm:text-left">
            <CardTitle className="text-xl font-bold text-white flex items-center justify-center sm:justify-start gap-2.5">
              <LogIn className="w-5 h-5 text-blue-500" />
              Sign In
            </CardTitle>
            <CardDescription className="text-zinc-500 text-[11px] font-medium leading-relaxed">
              Access your personalized feed stream.
            </CardDescription>
          </CardHeader>
          <CardContent className="px-8 pb-6">
            <form onSubmit={handleSubmit} className="space-y-4">
              <div className="relative group/input">
                <Mail className="absolute left-3.5 top-1/2 -translate-y-1/2 w-4 h-4 text-zinc-600 transition-colors group-focus-within/input:text-blue-500" />
                <Input
                  type="email"
                  placeholder="Email Address"
                  className="pl-10 bg-white/[0.04] border-white/5 text-white placeholder:text-zinc-700 focus:border-blue-500/50 focus:ring-blue-500/20 transition-all h-12 rounded-xl text-sm"
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  required
                />
              </div>
              <div className="relative group/input">
                <Lock className="absolute left-3.5 top-1/2 -translate-y-1/2 w-4 h-4 text-zinc-600 transition-colors group-focus-within/input:text-blue-500" />
                <Input
                  type="password"
                  placeholder="Password"
                  className="pl-10 bg-white/[0.04] border-white/5 text-white placeholder:text-zinc-700 focus:border-blue-500/50 focus:ring-blue-500/20 transition-all h-12 rounded-xl text-sm"
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  required
                />
              </div>

              {error && (
                <div className="p-3 rounded-xl bg-red-500/10 border border-red-500/20 text-red-400 text-[11px] font-bold animate-shake">
                  {error}
                </div>
              )}

              <Button
                type="submit"
                disabled={isLoading}
                className="w-full h-12 bg-blue-600 hover:bg-blue-500 text-white font-bold text-sm rounded-xl shadow-lg shadow-blue-900/40 group transition-all transform active:scale-[0.98] uppercase tracking-wider"
              >
                {isLoading ? (
                  <span className="flex items-center gap-2">
                    <div className="w-3.5 h-3.5 border-2 border-white/20 border-t-white rounded-full animate-spin" />
                    Authenticating...
                  </span>
                ) : (
                  <span className="flex items-center justify-center gap-2">
                    Sign In
                    <ArrowRight className="w-4 h-4 group-hover:translate-x-1 transition-transform" />
                  </span>
                )}
              </Button>
            </form>
          </CardContent>
          <CardFooter className="flex flex-col space-y-3 border-t border-white/5 pt-5 pb-7 bg-white/[0.01]">
            <div className="text-zinc-500 text-[11px] font-medium text-center w-full">
              Don&apos;t have an account?{" "}
              <Link
                href="/register"
                className="text-white hover:text-blue-400 font-bold underline underline-offset-4 decoration-blue-500/30 transition-all"
              >
                Create one now
              </Link>
            </div>
          </CardFooter>
        </Card>

        <div className="text-center mt-10 opacity-10 select-none">
          <p className="text-[9px] font-black tracking-[0.4em] text-white uppercase">
            Your News Hub
          </p>
        </div>
      </div>
    </div>
  );
}
