"use client";

import { useState, useEffect } from "react";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from "@/components/ui/dialog";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { ScrollArea } from "@/components/ui/scroll-area";
import {
  Users,
  Mail,
  AlertCircle,
  ShieldCheck,
  Shield,
  Loader2,
  Send,
  Globe,
  Settings2,
  Ban,
  RefreshCw,
  Trash2,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { cn } from "@/lib/utils";
import {
  getUsers,
  deleteUser,
  updateUserRole,
  suspendUser,
  unsuspendUser,
  getGlobalSettings,
  updateGlobalSettings,
  sendTestEmail,
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
  const [pendingDeleteUser, setPendingDeleteUser] = useState<any | null>(null);

  const loadData = async () => {
    setIsLoading(true);
    try {
      const [allUsers, globalSettings] = await Promise.all([getUsers(), getGlobalSettings()]);
      setUsers(allUsers);
      setSettings(globalSettings);
    } catch {
      toast.error("Failed to load server data");
    } finally {
      setIsLoading(false);
    }
  };

  useEffect(() => {
    if (open) loadData();
  }, [open]);

  const handleUpdateSettings = async (newData: any) => {
    setIsSaving(true);
    try {
      await updateGlobalSettings(newData);
      setSettings((prev: any) => ({ ...prev, ...newData }));
      toast.success("Settings saved");
    } catch (error: any) {
      toast.error(error?.message || "Failed to update settings");
    } finally {
      setIsSaving(false);
    }
  };

  const handleSendTestEmail = async () => {
    setIsSaving(true);
    try {
      const result = await sendTestEmail(settings);
      if (result.success) {
        toast.success(`Test email sent to ${result.sentTo}`);
      } else {
        toast.error(`Mail test failed: ${result.error}`);
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
      setUsers(users.map((u) => (u.id === user.id ? { ...u, role: newRole } : u)));
      toast.success(`Updated ${user.email} to ${newRole}`);
    } catch {
      toast.error("Failed to update user role");
    }
  };

  const handleToggleSuspend = async (user: any) => {
    try {
      if (user.isActive) {
        await suspendUser(user.id);
        setUsers(users.map((u) => (u.id === user.id ? { ...u, isActive: false } : u)));
        toast.success(`${user.email} suspended`);
      } else {
        await unsuspendUser(user.id);
        setUsers(users.map((u) => (u.id === user.id ? { ...u, isActive: true } : u)));
        toast.success(`${user.email} reactivated`);
      }
    } catch {
      toast.error("Failed to update user status");
    }
  };

  const handleDeleteUser = async (userId: string) => {
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
      <DialogContent className="max-w-[95vw] w-[95vw] max-h-[95vh] h-[95vh] flex flex-col overflow-hidden rounded-[2rem] border border-border/70 bg-background p-0 shadow-2xl sm:max-w-none">
        <DialogHeader className="border-b border-border/60 bg-card/95 p-6 pb-5 backdrop-blur-2xl sm:p-8 sm:pb-5">
          <div className="flex items-center justify-between">
            <div>
              <DialogTitle className="text-3xl font-semibold tracking-[-0.04em]">
                Server Management
              </DialogTitle>
              <DialogDescription className="mt-1 text-sm text-muted-foreground sm:text-base">
                Control server-wide settings, users, and integrations.
              </DialogDescription>
            </div>
          </div>
        </DialogHeader>

        <Tabs defaultValue="users" className="flex-1 flex flex-col min-h-0">
          <div className="px-6 py-4 sm:px-8 overflow-x-auto">
            <TabsList className="bg-muted/45 p-1 rounded-2xl w-fit border border-border/60 shadow-inner shadow-black/[0.02]">
              <TabsTrigger value="users" className="rounded-xl px-4 py-2.5 data-[state=active]:bg-background data-[state=active]:shadow-sm gap-2">
                <Users className="w-4 h-4" />
                Users
              </TabsTrigger>
              <TabsTrigger value="registrations" className="rounded-xl px-4 py-2.5 data-[state=active]:bg-background data-[state=active]:shadow-sm gap-2">
                <ShieldCheck className="w-4 h-4" />
                Access
              </TabsTrigger>
              <TabsTrigger value="email" className="rounded-xl px-4 py-2.5 data-[state=active]:bg-background data-[state=active]:shadow-sm gap-2">
                <Mail className="w-4 h-4" />
                Email
              </TabsTrigger>
              <TabsTrigger value="instance" className="rounded-xl px-4 py-2.5 data-[state=active]:bg-background data-[state=active]:shadow-sm gap-2">
                <Globe className="w-4 h-4" />
                Instance
              </TabsTrigger>
              <TabsTrigger value="sync" className="rounded-xl px-4 py-2.5 data-[state=active]:bg-background data-[state=active]:shadow-sm gap-2">
                <Settings2 className="w-4 h-4" />
                Sync
              </TabsTrigger>
            </TabsList>
          </div>

          <div className="flex-1 min-h-0">
            {isLoading ? (
              <div className="h-full flex items-center justify-center bg-background">
                <Loader2 className="w-8 h-8 animate-spin text-muted-foreground" />
              </div>
            ) : (
              <>
                {/* ── USERS ── */}
                <TabsContent value="users" className="h-full mt-0 focus-visible:outline-none">
                  <div className="px-6 sm:px-8 flex flex-col h-full">
                    <div className="flex justify-between items-center mb-6">
                      <Input
                        placeholder="Search users..."
                        className="h-11 rounded-2xl bg-card border-border/70 max-w-md"
                        value={searchQuery}
                        onChange={(e) => setSearchQuery(e.target.value)}
                      />
                    </div>
                    <ScrollArea className="flex-1">
                      <div className="space-y-3 pb-8">
                        {filteredUsers.map((user) => (
                          <div
                            key={user.id}
                            className={cn(
                              "flex items-center gap-4 p-4 rounded-3xl border shadow-sm transition-all hover:border-border",
                              user.isActive
                                ? "bg-card border-border/60"
                                : "bg-muted/30 border-border/40 opacity-70",
                            )}
                          >
                            <div className="w-10 h-10 rounded-2xl bg-primary/10 flex items-center justify-center text-primary font-semibold">
                              {user.name?.[0] || user.email?.[0]?.toUpperCase()}
                            </div>
                            <div className="flex-1 min-w-0">
                              <div className="font-semibold truncate flex items-center gap-2 tracking-[-0.01em]">
                                {user.name || "Unnamed User"}
                                {user.role === "ADMIN" && (
                                  <span className="text-[10px] bg-primary/10 text-primary px-1.5 py-0.5 rounded-full font-bold">
                                    ADMIN
                                  </span>
                                )}
                                {!user.isActive && (
                                  <span className="text-[10px] bg-destructive/10 text-destructive px-1.5 py-0.5 rounded-full font-bold">
                                    SUSPENDED
                                  </span>
                                )}
                              </div>
                              <div className="text-xs text-muted-foreground truncate">{user.email}</div>
                            </div>
                            <div className="flex gap-2">
                              <Button
                                size="sm"
                                variant="ghost"
                                className={cn("rounded-lg transition-colors", user.role === "ADMIN" ? "text-primary" : "text-muted-foreground")}
                                onClick={() => handleToggleRole(user)}
                                title={user.role === "ADMIN" ? "Remove admin" : "Make admin"}
                              >
                                {user.role === "ADMIN" ? <ShieldCheck className="w-4 h-4" /> : <Shield className="w-4 h-4" />}
                              </Button>
                              <Button
                                size="sm"
                                variant="ghost"
                                className={cn("rounded-lg transition-colors", user.isActive ? "text-amber-500 hover:bg-amber-500/10" : "text-emerald-500 hover:bg-emerald-500/10")}
                                onClick={() => handleToggleSuspend(user)}
                                title={user.isActive ? "Suspend user" : "Reactivate user"}
                              >
                                {user.isActive ? <Ban className="w-4 h-4" /> : <RefreshCw className="w-4 h-4" />}
                              </Button>
                              <Button
                                size="sm"
                                variant="ghost"
                                className="rounded-lg text-destructive hover:bg-destructive/10"
                                onClick={() => setPendingDeleteUser(user)}
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

                {/* ── ACCESS / REGISTRATIONS ── */}
                <TabsContent value="registrations" className="px-6 sm:px-8 py-6 space-y-6">
                  <div className="max-w-2xl space-y-8">
                    <div className="flex items-center justify-between p-6 rounded-3xl bg-card border border-border/60 shadow-sm">
                      <div className="space-y-1">
                        <h4 className="text-lg font-semibold tracking-[-0.02em]">Allow New Registrations</h4>
                        <p className="text-sm text-muted-foreground">
                          When disabled, only existing users can log in. New users cannot sign up.
                        </p>
                      </div>
                      <Switch
                        checked={settings?.registrationsEnabled ?? true}
                        onCheckedChange={(checked) => handleUpdateSettings({ registrationsEnabled: checked })}
                      />
                    </div>
                    <div className="p-6 rounded-3xl bg-amber-500/10 border border-amber-500/20 space-y-3">
                      <div className="flex items-center gap-2 text-amber-500">
                        <AlertCircle className="w-5 h-5" />
                        <h4 className="font-bold">Security Note</h4>
                      </div>
                      <p className="text-sm text-amber-500/80 leading-relaxed">
                        Disable registrations after setting up your accounts on a private server.
                        SaaS-provisioned users are created via the internal API regardless of this setting.
                      </p>
                    </div>
                  </div>
                </TabsContent>

                {/* ── EMAIL ── */}
                <TabsContent value="email" className="mt-0 focus-visible:outline-none">
                  <ScrollArea className="h-full">
                    <div className="px-6 sm:px-8 py-6 space-y-6 max-w-2xl">
                      {/* Enable toggle */}
                      <div className="flex items-center justify-between p-6 rounded-3xl bg-card border border-border/60 shadow-sm">
                        <div className="space-y-1">
                          <h4 className="text-lg font-semibold tracking-[-0.02em]">Mail Service</h4>
                          <p className="text-sm text-muted-foreground">
                            Enable magic links, digest emails, and welcome messages.
                          </p>
                        </div>
                        <Switch
                          checked={settings?.mailServiceEnabled ?? false}
                          onCheckedChange={(checked) => handleUpdateSettings({ mailServiceEnabled: checked })}
                        />
                      </div>

                      {settings?.mailServiceEnabled && (
                        <div className="grid gap-6 p-6 rounded-3xl bg-card border border-border/60 shadow-sm">
                          {/* Provider selection */}
                          <div className="space-y-2">
                            <Label>Email Provider</Label>
                            <Select
                              value={settings.mailProvider || "smtp"}
                              onValueChange={(value) => setSettings({ ...settings, mailProvider: value })}
                            >
                              <SelectTrigger className="rounded-2xl bg-background/70 border-border/70">
                                <SelectValue placeholder="Choose provider" />
                              </SelectTrigger>
                              <SelectContent className="rounded-2xl">
                                {["smtp", "resend", "postmark", "mailgun", "sendgrid"].map((id) => (
                                  <SelectItem key={id} value={id}>
                                    {id === "smtp" ? "SMTP" : id.charAt(0).toUpperCase() + id.slice(1)}
                                  </SelectItem>
                                ))}
                              </SelectContent>
                            </Select>
                          </div>

                          {/* SMTP fields */}
                          {settings.mailProvider === "smtp" && (
                            <>
                              <div className="grid grid-cols-2 gap-4">
                                <SettingsField label="SMTP Host" placeholder="smtp.gmail.com" field="smtpHost" settings={settings} setSettings={setSettings} />
                                <SettingsField label="Port" placeholder="587" field="smtpPort" settings={settings} setSettings={setSettings} type="number" />
                              </div>
                              <div className="grid grid-cols-2 gap-4">
                                <SettingsField label="Username" placeholder="user@gmail.com" field="smtpUser" settings={settings} setSettings={setSettings} />
                                <SettingsField label="Password" placeholder="••••••••" field="smtpPassword" settings={settings} setSettings={setSettings} type="password" isSecret />
                              </div>
                              <SettingsField label="From Email" placeholder="noreply@feedferret.cloud" field="smtpFrom" settings={settings} setSettings={setSettings} />
                            </>
                          )}

                          {/* Resend fields */}
                          {settings.mailProvider === "resend" && (
                            <>
                              <SettingsField label="Resend API Key" placeholder="re_…" field="resendApiKey" settings={settings} setSettings={setSettings} type="password" isSecret />
                              <SettingsField label="From Email" placeholder="FeedFerret <noreply@example.com>" field="resendFromEmail" settings={settings} setSettings={setSettings} />
                            </>
                          )}

                          {/* Postmark fields */}
                          {settings.mailProvider === "postmark" && (
                            <>
                              <SettingsField label="Server Token" placeholder="xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx" field="postmarkServerToken" settings={settings} setSettings={setSettings} type="password" isSecret />
                              <SettingsField label="From Email" placeholder="noreply@example.com" field="postmarkFromEmail" settings={settings} setSettings={setSettings} />
                              <SettingsField label="Message Stream" placeholder="outbound" field="postmarkMessageStream" settings={settings} setSettings={setSettings} />
                            </>
                          )}

                          {/* Mailgun fields */}
                          {settings.mailProvider === "mailgun" && (
                            <>
                              <SettingsField label="API Key" placeholder="key-…" field="mailgunApiKey" settings={settings} setSettings={setSettings} type="password" isSecret />
                              <SettingsField label="Domain" placeholder="mg.example.com" field="mailgunDomain" settings={settings} setSettings={setSettings} />
                              <SettingsField label="From Email" placeholder="FeedFerret <noreply@example.com>" field="mailgunFromEmail" settings={settings} setSettings={setSettings} />
                              <SettingsField label="API Base URL (optional)" placeholder="https://api.eu.mailgun.net" field="mailgunBaseUrl" settings={settings} setSettings={setSettings} />
                            </>
                          )}

                          {/* SendGrid fields */}
                          {settings.mailProvider === "sendgrid" && (
                            <>
                              <SettingsField label="API Key" placeholder="SG.…" field="sendgridApiKey" settings={settings} setSettings={setSettings} type="password" isSecret />
                              <SettingsField label="From Email" placeholder="noreply@example.com" field="sendgridFromEmail" settings={settings} setSettings={setSettings} />
                            </>
                          )}

                          <div className="flex gap-3 justify-end pt-2">
                            <Button
                              variant="outline"
                              className="rounded-2xl px-6 gap-2"
                              onClick={handleSendTestEmail}
                              disabled={isSaving}
                            >
                              {isSaving ? <Loader2 className="w-4 h-4 animate-spin" /> : <Send className="w-4 h-4" />}
                              Send Test Email
                            </Button>
                            <Button
                              className="rounded-2xl px-8"
                              onClick={() => handleUpdateSettings(settings)}
                              disabled={isSaving}
                            >
                              {isSaving ? <Loader2 className="w-4 h-4 animate-spin" /> : "Save"}
                            </Button>
                          </div>
                        </div>
                      )}
                    </div>
                  </ScrollArea>
                </TabsContent>

                {/* ── INSTANCE ── */}
                <TabsContent value="instance" className="px-6 sm:px-8 py-6 space-y-6">
                  <div className="max-w-2xl grid gap-6 p-6 rounded-3xl bg-card border border-border/60 shadow-sm">
                    <SettingsField
                      label="Instance Name"
                      placeholder="FeedFerret"
                      field="instanceName"
                      settings={settings}
                      setSettings={setSettings}
                    />
                    <SettingsField
                      label="Public URL"
                      placeholder="https://rss.example.com"
                      field="instanceUrl"
                      settings={settings}
                      setSettings={setSettings}
                    />
                    <SettingsField
                      label="Authenticator App Label"
                      placeholder="FeedFerret"
                      field="totpIssuer"
                      settings={settings}
                      setSettings={setSettings}
                    />
                    <div className="flex justify-end pt-2">
                      <Button
                        className="rounded-2xl px-8"
                        onClick={() => handleUpdateSettings({
                          instanceName: settings?.instanceName,
                          instanceUrl: settings?.instanceUrl,
                          totpIssuer: settings?.totpIssuer,
                        })}
                        disabled={isSaving}
                      >
                        {isSaving ? <Loader2 className="w-4 h-4 animate-spin" /> : "Save"}
                      </Button>
                    </div>
                  </div>
                </TabsContent>

                {/* ── SYNC ── */}
                <TabsContent value="sync" className="px-6 sm:px-8 py-6 space-y-6">
                  <div className="max-w-2xl space-y-6">
                    <div className="flex items-center justify-between p-6 rounded-3xl bg-card border border-border/60 shadow-sm">
                      <div className="space-y-1">
                        <h4 className="text-lg font-semibold tracking-[-0.02em]">Background Sync</h4>
                        <p className="text-sm text-muted-foreground">
                          Automatically fetch new articles for all feeds at a regular interval.
                        </p>
                      </div>
                      <Switch
                        checked={settings?.backgroundSyncEnabled ?? true}
                        onCheckedChange={(checked) => handleUpdateSettings({ backgroundSyncEnabled: checked })}
                      />
                    </div>
                    {settings?.backgroundSyncEnabled !== false && (
                      <div className="p-6 rounded-3xl bg-card border border-border/60 shadow-sm space-y-4">
                        <div className="space-y-2">
                          <Label>Sync Interval (minutes)</Label>
                          <Input
                            type="number"
                            min={1}
                            max={60}
                            className="rounded-2xl bg-background/70 border-border/70 w-40"
                            value={settings?.backgroundSyncIntervalMinutes ?? 5}
                            onChange={(e) =>
                              setSettings({ ...settings, backgroundSyncIntervalMinutes: parseInt(e.target.value) || 5 })
                            }
                          />
                          <p className="text-xs text-muted-foreground">Minimum 1 minute. Changes take effect on next server restart.</p>
                        </div>
                        <div className="flex justify-end">
                          <Button
                            className="rounded-2xl px-8"
                            onClick={() => handleUpdateSettings({ backgroundSyncIntervalMinutes: settings?.backgroundSyncIntervalMinutes })}
                            disabled={isSaving}
                          >
                            {isSaving ? <Loader2 className="w-4 h-4 animate-spin" /> : "Save"}
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

        <AlertDialog
          open={!!pendingDeleteUser}
          onOpenChange={(nextOpen) => { if (!nextOpen) setPendingDeleteUser(null); }}
        >
          <AlertDialogContent className="rounded-3xl border-border/70 bg-background">
            <AlertDialogHeader>
              <AlertDialogTitle>Delete user?</AlertDialogTitle>
              <AlertDialogDescription>
                {pendingDeleteUser?.email || "This user"} and all related data will be removed. This cannot be undone.
              </AlertDialogDescription>
            </AlertDialogHeader>
            <AlertDialogFooter>
              <AlertDialogCancel className="rounded-2xl">Cancel</AlertDialogCancel>
              <AlertDialogAction
                className="rounded-2xl bg-destructive text-destructive-foreground hover:bg-destructive/90"
                onClick={() => {
                  if (!pendingDeleteUser) return;
                  handleDeleteUser(pendingDeleteUser.id);
                  setPendingDeleteUser(null);
                }}
              >
                Delete user
              </AlertDialogAction>
            </AlertDialogFooter>
          </AlertDialogContent>
        </AlertDialog>
      </DialogContent>
    </Dialog>
  );
}

function SettingsField({
  label,
  placeholder,
  field,
  settings,
  setSettings,
  type = "text",
  isSecret = false,
}: {
  label: string;
  placeholder: string;
  field: string;
  settings: any;
  setSettings: (s: any) => void;
  type?: string;
  isSecret?: boolean;
}) {
  const rawValue = settings?.[field];
  const hasStoredValue = rawValue === "__encrypted__";

  return (
    <div className="space-y-2">
      <Label>{label}</Label>
      <Input
        type={isSecret ? "password" : type}
        placeholder={hasStoredValue ? "••••••••  (stored — enter new value to change)" : placeholder}
        className="rounded-2xl bg-background/70 border-border/70"
        value={hasStoredValue ? "" : (rawValue ?? "")}
        onChange={(e) => setSettings({ ...settings, [field]: e.target.value })}
      />
      {hasStoredValue && (
        <p className="text-xs text-emerald-600 dark:text-emerald-400">✓ Value stored securely. Leave blank to keep existing.</p>
      )}
    </div>
  );
}
