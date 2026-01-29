"use client";

import { useState } from "react";
import { useSession } from "next-auth/react";
import {
  useUpdateProfile,
  useUpdateGlobalSettings,
} from "@/hooks/use-rss-data";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { toast } from "sonner";
import { User, Shield, Info, Clock, Save, BadgeCheck } from "lucide-react";
import { Separator } from "@/components/ui/separator";

export function SettingsDialog({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const { data: session } = useSession();
  const updateProfile = useUpdateProfile();
  const updateGlobalSettings = useUpdateGlobalSettings();

  const [name, setName] = useState(session?.user?.name || "");
  const [email, setEmail] = useState(session?.user?.email || "");
  const [updateFrequency, setUpdateFrequency] = useState("60");

  const handleUpdateProfile = () => {
    updateProfile.mutate(
      { name, email },
      {
        onSuccess: () => toast.success("Profile updated"),
        onError: () => toast.error("Failed to update profile"),
      },
    );
  };

  const handleUpdateSettings = () => {
    updateGlobalSettings.mutate(
      { defaultUpdateFrequency: parseInt(updateFrequency) },
      {
        onSuccess: () => toast.success("Settings updated"),
        onError: () => toast.error("Failed to update settings"),
      },
    );
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-[95vw] w-[95vw] max-h-[95vh] h-[95vh] p-0 overflow-hidden bg-card border-none shadow-2xl rounded-3xl sm:max-w-none">
        <div className="flex flex-col lg:flex-row h-full">
          {/* Sidebar */}
          <div className="w-full lg:w-48 bg-muted/30 p-6 flex flex-col gap-2 shrink-0">
            <div className="font-bold text-xs uppercase tracking-widest text-muted-foreground mb-4 px-3">
              Settings
            </div>
            <Button
              variant="secondary"
              className="justify-start gap-3 rounded-xl bg-background shadow-sm"
            >
              <User className="w-4 h-4" />
              Account
            </Button>
            <Button
              variant="ghost"
              className="justify-start gap-3 rounded-xl text-muted-foreground"
            >
              <Shield className="w-4 h-4" />
              Security
            </Button>
            <Button
              variant="ghost"
              className="justify-start gap-3 rounded-xl text-muted-foreground"
            >
              <Clock className="w-4 h-4" />
              Syncing
            </Button>
            <div className="mt-auto border-t border-border/50 pt-4">
              <div className="flex items-center gap-2 px-3 text-xs text-muted-foreground">
                <Info className="w-3 h-3" />
                FeedFerret v0.1.0
              </div>
            </div>
          </div>

          {/* Content */}
          <div className="flex-1 p-8 overflow-y-auto">
            <div className="space-y-8">
              <div>
                <h3 className="text-2xl font-bold flex items-center gap-2">
                  <User className="w-6 h-6 text-primary" />
                  Account Profile
                </h3>
                <p className="text-muted-foreground mt-1">
                  Manage your public identity and email.
                </p>

                <div className="mt-6 space-y-4">
                  <div className="grid gap-2">
                    <Label htmlFor="name" className="text-sm font-semibold">
                      Display Name
                    </Label>
                    <Input
                      id="name"
                      value={name}
                      onChange={(e) => setName(e.target.value)}
                      className="rounded-xl border-muted bg-muted/10 h-11"
                      placeholder="John Doe"
                    />
                  </div>
                  <div className="grid gap-2">
                    <Label htmlFor="email" className="text-sm font-semibold">
                      Email Address
                    </Label>
                    <Input
                      id="email"
                      type="email"
                      value={email}
                      onChange={(e) => setEmail(e.target.value)}
                      className="rounded-xl border-muted bg-muted/10 h-11"
                      placeholder="john@example.com"
                    />
                  </div>
                  <Button
                    onClick={handleUpdateProfile}
                    className="w-full lg:w-fit rounded-xl px-8 h-11 bg-primary text-primary-foreground shadow-lg shadow-primary/20 active:scale-95 transition-all"
                    disabled={updateProfile.isPending}
                  >
                    {updateProfile.isPending ? "Saving..." : "Save Changes"}
                  </Button>
                </div>
              </div>

              <Separator className="bg-border/50" />

              <div>
                <h3 className="text-2xl font-bold flex items-center gap-2">
                  <Clock className="w-6 h-6 text-primary" />
                  Global Preferences
                </h3>
                <p className="text-muted-foreground mt-1">
                  Default behavior for all your feeds.
                </p>

                <div className="mt-6 space-y-4">
                  <div className="grid gap-2">
                    <Label
                      htmlFor="frequency"
                      className="text-sm font-semibold"
                    >
                      Default Sync Frequency (minutes)
                    </Label>
                    <div className="flex gap-4">
                      <Input
                        id="frequency"
                        type="number"
                        value={updateFrequency}
                        onChange={(e) => setUpdateFrequency(e.target.value)}
                        className="rounded-xl border-muted bg-muted/10 h-11 flex-1"
                      />
                      <Button
                        variant="outline"
                        className="rounded-xl px-4 h-11 border-muted hover:bg-muted font-bold"
                        onClick={handleUpdateSettings}
                        disabled={updateGlobalSettings.isPending}
                      >
                        <Save className="w-4 h-4" />
                      </Button>
                    </div>
                    <p className="text-[10px] text-muted-foreground px-1 italic">
                      Lower frequency improves freshness but increases server
                      resource usage.
                    </p>
                  </div>
                </div>
              </div>
            </div>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
