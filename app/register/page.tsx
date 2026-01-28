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

export default function RegisterPage() {
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [error, setError] = useState("");
  const [isLoading, setIsLoading] = useState(false);
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
        router.push("/login?registered=true");
      } else {
        const data = await response.json();
        setError(data.message || "Something went wrong");
      }
    } catch (err) {
      setError("Failed to register. Please try again.");
    } finally {
      setIsLoading(false);
    }
  };

  return (
    <div className="min-h-screen flex items-center justify-center p-4 bg-[#05060a] relative overflow-hidden text-white selection:bg-blue-500/30">
      {/* Background Orbs */}
      <div className="absolute top-[-10%] left-[-10%] w-[50%] h-[50%] bg-blue-600/15 rounded-full blur-[140px] animate-pulse" />
      <div className="absolute bottom-[-10%] right-[-10%] w-[50%] h-[50%] bg-indigo-600/15 rounded-full blur-[140px] animate-pulse delay-1000" />

      <div className="w-full max-md relative z-10 animate-scale-in">
        <div className="text-center mb-10 group">
          <div className="inline-flex items-center justify-center w-20 h-20 rounded-[28%] bg-gradient-to-br from-blue-500 to-indigo-600 p-[2px] mb-6 shadow-2xl transition-all duration-500 group-hover:scale-110">
            <div className="w-full h-full bg-[#05060a] rounded-[24%] flex items-center justify-center overflow-hidden">
              <img
                src="/logo.svg"
                alt="FeedFox"
                className="w-12 h-12 invert brightness-200"
              />
            </div>
          </div>
          <h1 className="text-4xl font-black tracking-tighter text-white">
            Join Feed<span className="text-blue-500">Fox</span>
          </h1>
          <p className="text-zinc-400 mt-2 font-medium tracking-wide">
            Create your elite news HQ
          </p>
        </div>

        <Card className="border-white/10 bg-white/[0.03] backdrop-blur-2xl shadow-2xl overflow-hidden ring-1 ring-white/10">
          <div className="absolute inset-0 bg-gradient-to-br from-white/10 to-transparent pointer-events-none" />
          <CardHeader>
            <CardTitle className="text-2xl font-bold text-white flex items-center gap-2">
              <UserPlus className="w-6 h-6 text-blue-500" />
              Create Account
            </CardTitle>
            <CardDescription className="text-zinc-400 font-medium">
              Start your journey with elite feed management
            </CardDescription>
          </CardHeader>
          <CardContent>
            <form onSubmit={handleSubmit} className="space-y-4">
              <div className="relative group/input">
                <User className="absolute left-4 top-1/2 -translate-y-1/2 w-5 h-5 text-zinc-500 group-focus-within/input:text-blue-500 transition-colors" />
                <Input
                  placeholder="Full Name"
                  className="pl-12 bg-white/[0.05] border-white/10 text-white placeholder:text-zinc-600 focus:border-blue-500/50 transition-all h-14 rounded-xl"
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  required
                />
              </div>
              <div className="relative group/input">
                <Mail className="absolute left-4 top-1/2 -translate-y-1/2 w-5 h-5 text-zinc-500 group-focus-within/input:text-blue-500 transition-colors" />
                <Input
                  type="email"
                  placeholder="Email Address"
                  className="pl-12 bg-white/[0.05] border-white/10 text-white placeholder:text-zinc-600 focus:border-blue-500/50 transition-all h-14 rounded-xl"
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  required
                />
              </div>
              <div className="grid grid-cols-2 gap-4">
                <div className="relative group/input">
                  <Lock className="absolute left-4 top-1/2 -translate-y-1/2 w-5 h-5 text-zinc-500 group-focus-within/input:text-blue-500 transition-colors" />
                  <Input
                    type="password"
                    placeholder="Password"
                    className="pl-12 bg-white/[0.05] border-white/10 text-white placeholder:text-zinc-600 focus:border-blue-500/50 transition-all h-14 rounded-xl"
                    value={password}
                    onChange={(e) => setPassword(e.target.value)}
                    required
                  />
                </div>
                <div className="relative group/input">
                  <ShieldCheck className="absolute left-4 top-1/2 -translate-y-1/2 w-5 h-5 text-zinc-500 group-focus-within/input:text-blue-500 transition-colors" />
                  <Input
                    type="password"
                    placeholder="Confirm"
                    className="pl-12 bg-white/[0.05] border-white/10 text-white placeholder:text-zinc-600 focus:border-blue-500/50 transition-all h-14 rounded-xl"
                    value={confirmPassword}
                    onChange={(e) => setConfirmPassword(e.target.value)}
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
                className="w-full h-14 bg-blue-600 hover:bg-blue-500 text-white font-black text-lg rounded-xl shadow-lg group transition-all transform active:scale-[0.98] uppercase tracking-wide"
              >
                {isLoading ? "Creating..." : "Register"}
                {!isLoading && (
                  <ArrowRight className="ml-2 w-5 h-5 group-hover:translate-x-1 transition-transform" />
                )}
              </Button>
            </form>
          </CardContent>
          <CardFooter className="flex flex-col space-y-4 border-t border-white/10 pt-6 pb-8 bg-white/[0.01]">
            <div className="text-zinc-400 font-medium">
              Already have an account?{" "}
              <Link
                href="/login"
                className="text-white hover:text-blue-400 font-black underline underline-offset-8 decoration-blue-500/30 transition-all"
              >
                Sign In
              </Link>
            </div>
          </CardFooter>
        </Card>
      </div>
    </div>
  );
}
