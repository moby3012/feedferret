"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Card,
  CardHeader,
  CardTitle,
  CardDescription,
  CardContent,
} from "@/components/ui/card";
import {
  Sparkles,
  ArrowRight,
  UserPlus,
  Mail,
  Lock,
  ShieldCheck,
} from "lucide-react";

export default function SetupPage() {
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState("");
  const router = useRouter();

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError("");

    if (password !== confirmPassword) {
      setError("Passwords do not match");
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
        router.push("/login?setup=success");
      } else {
        const data = await response.json();
        setError(data.message || "Initialization failed. Check server logs.");
      }
    } catch (err) {
      setError("Failed to connect to the server engine.");
    } finally {
      setIsLoading(false);
    }
  };

  return (
    <div className="min-h-screen flex items-center justify-center p-6 bg-[#05060a] relative overflow-hidden text-white selection:bg-blue-500/30">
      {/* Background Orbs */}
      <div className="absolute top-[-10%] left-[-10%] w-[50%] h-[50%] bg-blue-600/15 rounded-full blur-[140px] animate-pulse" />
      <div className="absolute bottom-[-10%] right-[-10%] w-[50%] h-[50%] bg-indigo-600/15 rounded-full blur-[140px] animate-pulse delay-700" />

      <div className="w-full max-w-md relative z-10 animate-scale-in">
        <div className="text-center mb-10 group">
          <div className="inline-flex items-center justify-center w-20 h-20 rounded-[28%] bg-gradient-to-br from-blue-500 to-indigo-600 p-[2px] mb-6 shadow-2xl shadow-blue-500/30 transition-all duration-700 group-hover:rotate-12 group-hover:scale-110">
            <div className="w-full h-full bg-[#05060a] rounded-[24%] flex items-center justify-center overflow-hidden">
              <img
                src="/logo.svg"
                alt="FeedFox"
                className="w-12 h-12 invert brightness-200"
              />
            </div>
          </div>
          <h1 className="text-4xl font-black tracking-tighter mb-2 drop-shadow-2xl">
            Feed<span className="text-blue-500">Fox</span>{" "}
            <span className="text-zinc-600">Setup</span>
          </h1>
          <p className="text-zinc-400 text-lg font-medium tracking-wide">
            Deploy your elite personal news sanctuary.
          </p>
        </div>

        <Card className="border-white/10 bg-white/[0.02] backdrop-blur-3xl shadow-[0_32px_64px_-12px_rgba(0,0,0,0.8)] overflow-hidden ring-1 ring-white/10">
          <div className="absolute inset-0 bg-gradient-to-br from-white/10 to-transparent pointer-events-none opacity-50" />
          <CardHeader className="space-y-1 pb-6 pt-8 text-center sm:text-left">
            <CardTitle className="text-2xl font-black text-white flex items-center justify-center sm:justify-start gap-3">
              <ShieldCheck className="w-7 h-7 text-blue-500" />
              Admin Account
            </CardTitle>
            <CardDescription className="text-zinc-400 text-sm font-medium">
              Establish the master account to unlock FeedFox.
            </CardDescription>
          </CardHeader>
          <CardContent className="pb-8">
            <form onSubmit={handleSubmit} className="space-y-4">
              <div className="relative group/input">
                <UserPlus className="absolute left-4 top-1/2 -translate-y-1/2 w-5 h-5 text-zinc-500 group-focus-within/input:text-blue-500 transition-colors" />
                <Input
                  placeholder="Administrator Name"
                  className="pl-12 bg-white/[0.05] border-white/10 text-white placeholder:text-zinc-600 focus:border-blue-500/50 focus:ring-blue-500/20 transition-all h-14 rounded-xl"
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  required
                />
              </div>
              <div className="relative group/input">
                <Mail className="absolute left-4 top-1/2 -translate-y-1/2 w-5 h-5 text-zinc-500 group-focus-within/input:text-blue-500 transition-colors" />
                <Input
                  type="email"
                  placeholder="Admin Email"
                  className="pl-12 bg-white/[0.05] border-white/10 text-white placeholder:text-zinc-600 focus:border-blue-500/50 focus:ring-blue-500/20 transition-all h-14 rounded-xl"
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  required
                />
              </div>
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                <div className="relative group/input">
                  <Lock className="absolute left-4 top-1/2 -translate-y-1/2 w-5 h-5 text-zinc-500 group-focus-within/input:text-blue-500 transition-colors" />
                  <Input
                    type="password"
                    placeholder="Password"
                    className="pl-12 bg-white/[0.05] border-white/10 text-white placeholder:text-zinc-600 focus:border-blue-500/50 focus:ring-blue-500/20 transition-all h-14 rounded-xl"
                    value={password}
                    onChange={(e) => setPassword(e.target.value)}
                    required
                  />
                </div>
                <div className="relative group/input">
                  <Lock className="absolute left-4 top-1/2 -translate-y-1/2 w-5 h-5 text-zinc-500 group-focus-within/input:text-blue-500 transition-colors" />
                  <Input
                    type="password"
                    placeholder="Confirm"
                    className="pl-12 bg-white/[0.05] border-white/10 text-white placeholder:text-zinc-600 focus:border-blue-500/50 focus:ring-blue-500/20 transition-all h-14 rounded-xl"
                    value={confirmPassword}
                    onChange={(e) => setConfirmPassword(e.target.value)}
                    required
                  />
                </div>
              </div>

              {error && (
                <div className="p-4 rounded-xl bg-red-500/10 border border-red-500/30 text-red-400 text-sm font-black animate-shake flex items-center gap-2">
                  <div className="w-2 h-2 rounded-full bg-red-400 animate-pulse" />
                  {error}
                </div>
              )}

              <Button
                type="submit"
                disabled={isLoading}
                className="w-full h-14 bg-blue-600 hover:bg-blue-500 text-white font-black text-lg rounded-xl shadow-2xl shadow-blue-900/40 group transition-all transform active:scale-95 uppercase tracking-widest"
              >
                {isLoading ? (
                  <span className="flex items-center gap-2 text-sm">
                    <div className="w-4 h-4 border-2 border-white/20 border-t-white rounded-full animate-spin" />
                    Initializing...
                  </span>
                ) : (
                  <span className="flex items-center gap-2">
                    Initialize
                    <ArrowRight className="w-5 h-5 group-hover:translate-x-1 transition-transform" />
                  </span>
                )}
              </Button>
            </form>
          </CardContent>
        </Card>

        <div className="flex justify-center gap-8 mt-10 opacity-30">
          <p className="text-[9px] font-black tracking-[.3em] text-white uppercase flex items-center gap-1.5">
            <div className="w-1.5 h-1.5 rounded-full bg-blue-500" />
            Standalone
          </p>
          <p className="text-[9px] font-black tracking-[.3em] text-white uppercase flex items-center gap-1.5">
            <div className="w-1.5 h-1.5 rounded-full bg-indigo-500" />
            Elite
          </p>
        </div>
      </div>
    </div>
  );
}
