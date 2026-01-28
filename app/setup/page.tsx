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
import { Sparkles, ArrowRight, UserPlus, Mail, Lock } from "lucide-react";

export default function SetupPage() {
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState("");
  const router = useRouter();

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setIsLoading(true);
    setError("");

    try {
      const response = await fetch("/api/register", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name, email, password }),
      });

      if (response.ok) {
        // Automatically sign in or redirect to login
        router.push("/login?setup=success");
      } else {
        const data = await response.json();
        setError(data.message || "Something went wrong");
      }
    } catch (err) {
      setError("Failed to create the initial account");
    } finally {
      setIsLoading(false);
    }
  };

  return (
    <div className="min-h-screen flex items-center justify-center p-4 bg-[#0a0b10] relative overflow-hidden">
      {/* Background Orbs */}
      <div className="absolute top-[-10%] left-[-10%] w-[40%] h-[40%] bg-primary/20 rounded-full blur-[120px] animate-pulse" />
      <div className="absolute bottom-[-10%] right-[-10%] w-[40%] h-[40%] bg-accent/20 rounded-full blur-[120px] animate-pulse delay-700" />

      <div className="w-full max-w-lg relative z-10 animate-scale-in">
        <div className="text-center mb-8">
          <div className="inline-flex items-center justify-center w-20 h-20 rounded-3xl bg-gradient-to-br from-primary to-accent p-[2px] mb-6 shadow-2xl shadow-primary/20">
            <div className="w-full h-full bg-[#0a0b10] rounded-[22px] flex items-center justify-center overflow-hidden">
              <img src="/logo.svg" alt="FeedFox" className="w-12 h-12 invert" />
            </div>
          </div>
          <h1 className="text-4xl font-black tracking-tight text-white mb-2">
            Feed<span className="text-primary">Fox</span>
          </h1>
          <p className="text-muted-foreground text-lg">
            Welcome to your personal news sanctuary.
          </p>
        </div>

        <Card className="border-white/5 bg-white/5 backdrop-blur-xl shadow-2xl overflow-hidden">
          <div className="absolute inset-0 bg-gradient-to-br from-white/5 to-transparent pointer-events-none" />
          <CardHeader>
            <CardTitle className="flex items-center gap-2 text-white">
              <Sparkles className="w-5 h-5 text-primary" />
              Initial Setup
            </CardTitle>
            <CardDescription className="text-white/60">
              Create the administrator account to get started.
            </CardDescription>
          </CardHeader>
          <CardContent>
            <form onSubmit={handleSubmit} className="space-y-5">
              <div className="space-y-2">
                <div className="relative">
                  <UserPlus className="absolute left-3 top-3 w-5 h-5 text-white/40" />
                  <Input
                    placeholder="Full Name"
                    className="pl-10 bg-white/5 border-white/10 text-white placeholder:text-white/30 focus:border-primary/50 transition-all h-12"
                    value={name}
                    onChange={(e) => setName(e.target.value)}
                    required
                  />
                </div>
              </div>
              <div className="space-y-2">
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
              </div>
              <div className="space-y-2">
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
              </div>

              {error && (
                <div className="p-3 rounded-lg bg-destructive/10 border border-destructive/20 text-destructive text-sm font-medium">
                  {error}
                </div>
              )}

              <Button
                type="submit"
                disabled={isLoading}
                className="w-full h-12 bg-primary hover:bg-primary/90 text-primary-foreground font-bold text-lg group transition-all"
              >
                {isLoading ? (
                  "Starting Engine..."
                ) : (
                  <>
                    Complete Setup
                    <ArrowRight className="ml-2 w-5 h-5 group-hover:translate-x-1 transition-transform" />
                  </>
                )}
              </Button>
            </form>
          </CardContent>
        </Card>

        <p className="text-center mt-8 text-white/20 text-sm font-medium tracking-widest uppercase">
          Powered by DeepMind Advanced Agentic Coding
        </p>
      </div>
    </div>
  );
}
