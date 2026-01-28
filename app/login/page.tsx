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
    <div className="min-h-screen flex items-center justify-center p-6 bg-[#05060a] relative overflow-hidden text-white selection:bg-blue-500/30">
      {/* Background Orbs */}
      <div className="absolute top-[-10%] right-[-10%] w-[50%] h-[50%] bg-blue-600/20 rounded-full blur-[120px] animate-pulse" />
      <div className="absolute bottom-[-10%] left-[-10%] w-[50%] h-[50%] bg-indigo-600/20 rounded-full blur-[120px] animate-pulse delay-700" />

      <div className="w-full max-w-md relative z-10 animate-scale-in">
        <div className="text-center mb-10 group">
          <div className="inline-flex items-center justify-center w-20 h-20 rounded-[28%] bg-gradient-to-br from-blue-500 to-indigo-600 p-[2px] mb-6 shadow-2xl shadow-blue-500/40 transition-transform duration-500 group-hover:scale-110">
            <div className="w-full h-full bg-[#05060a] rounded-[24%] flex items-center justify-center overflow-hidden">
              <img
                src="/logo.svg"
                alt="FeedFox"
                className="w-12 h-12 invert brightness-200"
              />
            </div>
          </div>
          <h1 className="text-4xl font-black tracking-tighter text-white drop-shadow-sm">
            Welcome to Feed<span className="text-blue-500">Fox</span>
          </h1>
          <p className="text-zinc-400 mt-2 font-medium tracking-wide flex items-center justify-center gap-2">
            <Sparkles className="w-4 h-4 text-blue-400" />
            Your Elite News Sanctuary
          </p>
        </div>

        <Card className="border-white/10 bg-white/[0.03] backdrop-blur-2xl shadow-[0_0_50px_-12px_rgba(0,0,0,0.5)] overflow-hidden ring-1 ring-white/10">
          <div className="absolute inset-0 bg-gradient-to-br from-white/10 to-transparent pointer-events-none" />
          <CardHeader className="pb-6 text-center sm:text-left">
            <CardTitle className="text-2xl font-bold text-white flex items-center justify-center sm:justify-start gap-3">
              <LogIn className="w-6 h-6 text-blue-500" />
              Sign In
            </CardTitle>
            <CardDescription className="text-zinc-400 font-medium">
              Access your personalized feed stream
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-6">
            <form onSubmit={handleSubmit} className="space-y-4">
              <div className="space-y-2">
                <div className="relative group/input">
                  <Mail className="absolute left-4 top-1/2 -translate-y-1/2 w-5 h-5 text-zinc-500 transition-colors group-focus-within/input:text-blue-500" />
                  <Input
                    type="email"
                    placeholder="Email Address"
                    className="pl-12 bg-white/[0.05] border-white/10 text-white placeholder:text-zinc-600 focus:border-blue-500/50 focus:ring-blue-500/20 transition-all h-14 rounded-xl text-lg"
                    value={email}
                    onChange={(e) => setEmail(e.target.value)}
                    required
                  />
                </div>
              </div>
              <div className="space-y-2">
                <div className="relative group/input">
                  <Lock className="absolute left-4 top-1/2 -translate-y-1/2 w-5 h-5 text-zinc-500 transition-colors group-focus-within/input:text-blue-500" />
                  <Input
                    type="password"
                    placeholder="Password"
                    className="pl-12 bg-white/[0.05] border-white/10 text-white placeholder:text-zinc-600 focus:border-blue-500/50 focus:ring-blue-500/20 transition-all h-14 rounded-xl text-lg"
                    value={password}
                    onChange={(e) => setPassword(e.target.value)}
                    required
                  />
                </div>
              </div>

              {error && (
                <div className="p-4 rounded-xl bg-red-500/10 border border-red-500/30 text-red-400 text-sm font-bold animate-shake">
                  {error}
                </div>
              )}

              <Button
                type="submit"
                disabled={isLoading}
                className="w-full h-14 bg-blue-600 hover:bg-blue-500 text-white font-black text-lg rounded-xl shadow-lg shadow-blue-900/40 group transition-all transform active:scale-[0.98]"
              >
                {isLoading ? (
                  <span className="flex items-center gap-2 text-sm font-bold">
                    <div className="w-4 h-4 border-2 border-white/30 border-t-white rounded-full animate-spin" />
                    Authenticating...
                  </span>
                ) : (
                  <span className="flex items-center justify-center gap-2 uppercase tracking-wide">
                    Sign In
                    <ArrowRight className="w-5 h-5 group-hover:translate-x-1 transition-transform" />
                  </span>
                )}
              </Button>
            </form>
          </CardContent>
          <CardFooter className="flex flex-col space-y-4 border-t border-white/10 pt-6 pb-8 bg-white/[0.01]">
            <div className="text-zinc-400 font-medium text-center w-full">
              Don&apos;t have an account?{" "}
              <Link
                href="/register"
                className="text-white hover:text-blue-400 font-black underline underline-offset-8 decoration-blue-500/30 transition-all"
              >
                Create one now
              </Link>
            </div>
          </CardFooter>
        </Card>

        <div className="text-center mt-12 opacity-30 select-none">
          <p className="text-[10px] font-black tracking-[0.4em] text-white uppercase">
            DeepMind Elite Integrated System
          </p>
        </div>
      </div>
    </div>
  );
}
