"use client";

import { useState, useEffect } from "react";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from "@/components/ui/dialog";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { ScrollArea } from "@/components/ui/scroll-area";
import {
  Users,
  Globe,
  Mail,
  ShieldAlert,
  UserPlus,
  Trash2,
  Ban,
  CheckCircle2,
  AlertCircle,
  ShieldCheck,
  Shield,
  Loader2,
  Send,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Separator } from "@/components/ui/separator";
import { Switch } from "@/components/ui/switch";
import { cn } from "@/lib/utils";
import {
  getUsers,
  deleteUser,
  updateUserRole,
  getGlobalSettings,
  updateGlobalSettings,
  testSmtp,
} from "@/app/actions/admin";
import { toast } from "sonner";

export function ServerManagementDialog({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const [users, setUsers] = useState<any[]>([]);
  const [settings, setSettings] = useState<any>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [isSaving, setIsSaving] = useState(false);
  const [searchQuery, setSearchQuery] = useState("");

  const loadData = async () => {
    setIsLoading(true);
    try {
      const [allUsers, globalSettings] = await Promise.all([
        getUsers(),
        getGlobalSettings(),
      ]);
      setUsers(allUsers);
      setSettings(globalSettings);
    } catch (error) {
      toast.error("Failed to load server data");
    } finally {
      setIsLoading(false);
    }
  };

  useEffect(() => {
    if (open) {
      loadData();
    }
  }, [open]);

  const handleUpdateSettings = async (newData: any) => {
    setIsSaving(true);
    try {
      await updateGlobalSettings(newData);
      setSettings((prev: any) => ({ ...prev, ...newData }));
      toast.success("Settings updated");
    } catch (error) {
      toast.error("Failed to update settings");
    } finally {
      setIsSaving(false);
    }
  };

  const handleTestSmtp = async () => {
    setIsSaving(true);
    try {
      const result = await testSmtp(settings);
      if (result.success) {
        toast.success("SMTP Connection successful!");
      } else {
        toast.error(`SMTP Failed: ${result.error}`);
      }
    } catch (error: any) {
      toast.error(error.message);
    } finally {
      setIsSaving(false);
    }
  };

  const handleToggleRole = async (user: any) => {
    const newRole = user.role === "ADMIN" ? "USER" : "ADMIN";
    try {
      await updateUserRole(user.id, newRole);
      setUsers(
        users.map((u) => (u.id === user.id ? { ...u, role: newRole } : u)),
      );
      toast.success(`Updated ${user.email} to ${newRole}`);
    } catch (error) {
      toast.error("Failed to update user role");
    }
  };

  const handleDeleteUser = async (userId: string) => {
    if (
      !confirm(
        "Are you sure you want to delete this user? This cannot be undone.",
      )
    )
      return;
    try {
      await deleteUser(userId);
      setUsers(users.filter((u) => u.id !== userId));
      toast.success("User deleted");
    } catch (error: any) {
      toast.error(error.message);
    }
  };

  const filteredUsers = users.filter(
    (u) =>
      u.email?.toLowerCase().includes(searchQuery.toLowerCase()) ||
      u.name?.toLowerCase().includes(searchQuery.toLowerCase()),
  );

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-[95vw] w-[1200px] max-h-[90vh] h-[800px] flex flex-col p-0 overflow-hidden bg-card border-none shadow-2xl rounded-3xl sm:max-w-none">
        <DialogHeader className="p-8 pb-4">
          <div className="flex items-center justify-between">
            <div>
              <DialogTitle className="text-3xl font-bold tracking-tight">
                Server Management
              </DialogTitle>
              <DialogDescription className="text-muted-foreground text-lg">
                Control server-wide settings, users, and integrations.
              </DialogDescription>
            </div>
          </div>
        </DialogHeader>

        <Tabs defaultValue="users" className="flex-1 flex flex-col min-h-0">
          <div className="px-8 mb-4">
            <TabsList className="bg-muted/50 p-1 rounded-2xl w-fit">
              <TabsTrigger
                value="users"
                className="rounded-xl px-6 py-2.5 data-[state=active]:bg-background data-[state=active]:shadow-sm gap-2"
              >
                <Users className="w-4 h-4" />
                User Management
              </TabsTrigger>
              <TabsTrigger
                value="registrations"
                className="rounded-xl px-6 py-2.5 data-[state=active]:bg-background data-[state=active]:shadow-sm gap-2"
              >
                <ShieldCheck className="w-4 h-4" />
                Registrations
              </TabsTrigger>
              <TabsTrigger
                value="smtp"
                className="rounded-xl px-6 py-2.5 data-[state=active]:bg-background data-[state=active]:shadow-sm gap-2"
              >
                <Mail className="w-4 h-4" />
                SMTP / Email
              </TabsTrigger>
            </TabsList>
          </div>

          <div className="flex-1 min-h-0">
            {isLoading ? (
              <div className="h-full flex items-center justify-center">
                <Loader2 className="w-8 h-8 animate-spin text-muted-foreground" />
              </div>
            ) : (
              <>
                <TabsContent
                  value="users"
                  className="h-full mt-0 focus-visible:outline-none"
                >
                  <div className="px-8 flex flex-col h-full">
                    <div className="flex justify-between items-center mb-6">
                      <div className="flex gap-2 flex-1 max-w-md">
                        <Input
                          placeholder="Search users..."
                          className="rounded-xl bg-muted/20"
                          value={searchQuery}
                          onChange={(e) => setSearchQuery(e.target.value)}
                        />
                      </div>
                    </div>

                    <ScrollArea className="flex-1">
                      <div className="space-y-3 pb-8">
                        {filteredUsers.map((user) => (
                          <div
                            key={user.id}
                            className="flex items-center gap-4 p-4 rounded-2xl bg-muted/30 border border-transparent hover:border-border transition-all"
                          >
                            <div className="w-10 h-10 rounded-full bg-primary/20 flex items-center justify-center text-primary font-bold">
                              {user.name?.[0] || user.email?.[0]?.toUpperCase()}
                            </div>
                            <div className="flex-1 min-w-0">
                              <div className="font-bold truncate flex items-center gap-2">
                                {user.name || "Unnamed User"}
                                {user.role === "ADMIN" && (
                                  <span className="text-[10px] bg-primary/10 text-primary px-1.5 py-0.5 rounded-full font-bold">
                                    ADMIN
                                  </span>
                                )}
                              </div>
                              <div className="text-xs text-muted-foreground truncate">
                                {user.email}
                              </div>
                            </div>
                            <div className="flex gap-2">
                              <Button
                                size="sm"
                                variant="ghost"
                                className={cn(
                                  "rounded-lg transition-colors",
                                  user.role === "ADMIN"
                                    ? "text-primary"
                                    : "text-muted-foreground",
                                )}
                                onClick={() => handleToggleRole(user)}
                              >
                                {user.role === "ADMIN" ? (
                                  <ShieldCheck className="w-4 h-4" />
                                ) : (
                                  <Shield className="w-4 h-4" />
                                )}
                              </Button>
                              <Button
                                size="sm"
                                variant="ghost"
                                className="rounded-lg text-destructive hover:bg-destructive/10"
                                onClick={() => handleDeleteUser(user.id)}
                              >
                                <Trash2 className="w-4 h-4" />
                              </Button>
                            </div>
                          </div>
                        ))}
                      </div>
                    </ScrollArea>
                  </div>
                </TabsContent>

                <TabsContent
                  value="registrations"
                  className="px-8 py-6 space-y-6"
                >
                  <div className="max-w-2xl space-y-8">
                    <div className="flex items-center justify-between p-6 rounded-3xl bg-muted/20 border">
                      <div className="space-y-1">
                        <h4 className="text-lg font-semibold">
                          Allow New Registrations
                        </h4>
                        <p className="text-sm text-muted-foreground line-clamp-2">
                          When disabled, only existing users can log in. New
                          users cannot sign up.
                        </p>
                      </div>
                      <Switch
                        checked={settings?.registrationsEnabled}
                        onCheckedChange={(checked) =>
                          handleUpdateSettings({
                            registrationsEnabled: checked,
                          })
                        }
                      />
                    </div>

                    <div className="p-6 rounded-3xl bg-amber-500/5 border border-amber-500/20 space-y-3">
                      <div className="flex items-center gap-2 text-amber-500">
                        <AlertCircle className="w-5 h-5" />
                        <h4 className="font-bold">Security Note</h4>
                      </div>
                      <p className="text-sm text-amber-500/80 leading-relaxed">
                        Disabling registrations is recommended after you have
                        set up your main accounts if this is a private server.
                      </p>
                    </div>
                  </div>
                </TabsContent>

                <TabsContent value="smtp" className="px-8 py-6 space-y-6">
                  <div className="max-w-2xl space-y-6">
                    <div className="flex items-center justify-between p-6 rounded-3xl bg-muted/20 border">
                      <div className="space-y-1">
                        <h4 className="text-lg font-semibold">
                          Activate Mail Service
                        </h4>
                        <p className="text-sm text-muted-foreground line-clamp-1">
                          Enable password resets and verification emails.
                        </p>
                      </div>
                      <Switch
                        checked={settings?.mailServiceEnabled}
                        onCheckedChange={(checked) =>
                          handleUpdateSettings({ mailServiceEnabled: checked })
                        }
                      />
                    </div>

                    {settings?.mailServiceEnabled && (
                      <div className="grid gap-6 p-6 rounded-3xl bg-muted/20 border animate-in fade-in slide-in-from-top-4 duration-300">
                        <div className="grid grid-cols-2 gap-4">
                          <div className="space-y-2">
                            <Label>SMTP Host</Label>
                            <Input
                              placeholder="smtp.gmail.com"
                              className="rounded-xl"
                              value={settings.smtpHost || ""}
                              onChange={(e) =>
                                setSettings({
                                  ...settings,
                                  smtpHost: e.target.value,
                                })
                              }
                            />
                          </div>
                          <div className="space-y-2">
                            <Label>Port</Label>
                            <Input
                              placeholder="587"
                              className="rounded-xl"
                              value={settings.smtpPort || ""}
                              onChange={(e) =>
                                setSettings({
                                  ...settings,
                                  smtpPort: parseInt(e.target.value) || 0,
                                })
                              }
                            />
                          </div>
                        </div>
                        <div className="grid grid-cols-2 gap-4">
                          <div className="space-y-2">
                            <Label>SMTP Username</Label>
                            <Input
                              placeholder="user@gmail.com"
                              className="rounded-xl"
                              value={settings.smtpUser || ""}
                              onChange={(e) =>
                                setSettings({
                                  ...settings,
                                  smtpUser: e.target.value,
                                })
                              }
                            />
                          </div>
                          <div className="space-y-2">
                            <Label>SMTP Password</Label>
                            <Input
                              type="password"
                              placeholder="••••••••"
                              className="rounded-xl"
                              value={settings.smtpPassword || ""}
                              onChange={(e) =>
                                setSettings({
                                  ...settings,
                                  smtpPassword: e.target.value,
                                })
                              }
                            />
                          </div>
                        </div>
                        <div className="space-y-2">
                          <Label>From Email</Label>
                          <Input
                            placeholder="noreply@feedferret.cloud"
                            className="rounded-xl"
                            value={settings.smtpFrom || ""}
                            onChange={(e) =>
                              setSettings({
                                ...settings,
                                smtpFrom: e.target.value,
                              })
                            }
                          />
                        </div>
                        <div className="flex gap-3 justify-end pt-2">
                          <Button
                            variant="outline"
                            className="rounded-xl px-6 gap-2"
                            onClick={handleTestSmtp}
                            disabled={isSaving}
                          >
                            {isSaving ? (
                              <Loader2 className="w-4 h-4 animate-spin" />
                            ) : (
                              <Send className="w-4 h-4" />
                            )}
                            Test Connection
                          </Button>
                          <Button
                            className="rounded-xl px-8"
                            onClick={() => handleUpdateSettings(settings)}
                            disabled={isSaving}
                          >
                            {isSaving ? (
                              <Loader2 className="w-4 h-4 animate-spin" />
                            ) : (
                              "Save Configuration"
                            )}
                          </Button>
                        </div>
                      </div>
                    )}
                  </div>
                </TabsContent>
              </>
            )}
          </div>
        </Tabs>
      </DialogContent>
    </Dialog>
  );
}
