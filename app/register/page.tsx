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
import { UserPlus, Mail, Lock, User, ArrowRight } from "lucide-react";

export default function RegisterPage() {
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [isLoading, setIsLoading] = useState(false);
  const router = useRouter();

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError("");
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
      setError("An unexpected error occurred");
    } finally {
      setIsLoading(false);
    }
  };

  return (
    <div className="min-h-screen flex items-center justify-center p-4 bg-[#0a0b10] relative overflow-hidden">
      {/* Background Orbs */}
      <div className="absolute top-[-10%] left-[-10%] w-[40%] h-[40%] bg-primary/20 rounded-full blur-[120px] animate-pulse" />
      <div className="absolute bottom-[-10%] right-[-10%] w-[40%] h-[40%] bg-accent/20 rounded-full blur-[120px] animate-pulse delay-700" />

      <div className="w-full max-w-md relative z-10 animate-scale-in">
        <div className="text-center mb-10">
          <div className="inline-flex items-center justify-center w-16 h-16 rounded-2xl bg-gradient-to-br from-primary to-accent p-[2px] mb-6">
            <div className="w-full h-full bg-[#0a0b10] rounded-[14px] flex items-center justify-center overflow-hidden">
              <img src="/logo.svg" alt="FeedFox" className="w-10 h-10 invert" />
            </div>
          </div>
          <h1 className="text-3xl font-black tracking-tight text-white">
            Join Feed<span className="text-primary">Fox</span>
          </h1>
        </div>

        <Card className="border-white/5 bg-white/5 backdrop-blur-xl shadow-2xl overflow-hidden">
          <div className="absolute inset-0 bg-gradient-to-br from-white/5 to-transparent pointer-events-none" />
          <CardHeader>
            <CardTitle className="text-xl text-white flex items-center gap-2">
              <UserPlus className="w-5 h-5 text-primary" />
              Create Account
            </CardTitle>
            <CardDescription className="text-white/60">
              Start your journey with elite feed management
            </CardDescription>
          </CardHeader>
          <CardContent>
            <form onSubmit={handleSubmit} className="space-y-4">
              <div className="relative">
                <User className="absolute left-3 top-3 w-5 h-5 text-white/40" />
                <Input
                  placeholder="Full Name"
                  className="pl-10 bg-white/5 border-white/10 text-white placeholder:text-white/30 focus:border-primary/50 transition-all h-12"
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  required
                />
              </div>
              <div className="relative">
                <Mail className="absolute left-3 top-3 w-5 h-5 text-white/40" />
                <Input
                  type="email"
                  placeholder="Email Address"
                  className="pl-10 bg-white/5 border-white/10 text-white placeholder:text-white/30 focus:border-primary/50 transition-all h-12"
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  required
                />
              </div>
              <div className="relative">
                <Lock className="absolute left-3 top-3 w-5 h-5 text-white/40" />
                <Input
                  type="password"
                  placeholder="Password"
                  className="pl-10 bg-white/5 border-white/10 text-white placeholder:text-white/30 focus:border-primary/50 transition-all h-12"
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  required
                />
              </div>

              {error && (
                <div className="p-3 rounded-lg bg-destructive/10 border border-destructive/20 text-destructive text-sm font-medium">
                  {error}
                </div>
              )}

              <Button
                type="submit"
                disabled={isLoading}
                className="w-full h-12 bg-primary hover:bg-primary/90 text-primary-foreground font-bold group transition-all"
              >
                {isLoading ? "Creating..." : "Register"}
                {!isLoading && (
                  <ArrowRight className="ml-2 w-4 h-4 group-hover:translate-x-1 transition-transform" />
                )}
              </Button>
            </form>
          </CardContent>
          <CardFooter className="flex flex-col space-y-4 border-t border-white/5 pt-6 bg-white/[0.02]">
            <div className="text-sm text-center text-white/60">
              Already have an account?{" "}
              <Link
                href="/login"
                className="text-primary hover:text-primary/80 font-bold transition-colors"
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
