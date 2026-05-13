"use client";

import { useState, useEffect } from "react";
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
import { TabsContent } from "@/components/ui/tabs";
import { SettingsModalShell } from "@/components/settings-shell";
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
  PackagePlus,
  Plus,
  X,
  Image as ImageIcon,
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
import { DEFAULT_STARTER_PACKS, stringifyStarterPacks, type StarterPack } from "@/lib/starter-packs";

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
  const [activeTab, setActiveTab] = useState("users");

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
    } catch (error: any) {
      toast.error(error?.message || "Failed to update user role");
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
  const starterPacks = (settings?.starterPacks ?? []) as StarterPack[];
  const setStarterPacks = (packs: StarterPack[]) => {
    setSettings({ ...settings, starterPacks: packs, starterPacksJson: stringifyStarterPacks(packs) });
  };
  const updatePack = (index: number, patch: Partial<StarterPack>) => {
    setStarterPacks(starterPacks.map((pack, i) => (i === index ? { ...pack, ...patch } : pack)));
  };
  const updatePackFeed = (packIndex: number, feedIndex: number, patch: any) => {
    setStarterPacks(starterPacks.map((pack, i) => (
      i === packIndex
        ? { ...pack, feeds: pack.feeds.map((feed, j) => (j === feedIndex ? { ...feed, ...patch } : feed)) }
        : pack
    )));
  };
  const addPack = () => {
    setStarterPacks([
      ...starterPacks,
      { id: `custom-${Date.now()}`, name: "New starter pack", description: "", enabled: true, feeds: [] },
    ]);
  };
  const addPackFeed = (packIndex: number) => {
    setStarterPacks(starterPacks.map((pack, i) => (
      i === packIndex
        ? { ...pack, feeds: [...pack.feeds, { title: "New feed", xmlUrl: "", htmlUrl: "", category: "" }] }
        : pack
    )));
  };
  const removePackFeed = (packIndex: number, feedIndex: number) => {
    setStarterPacks(starterPacks.map((pack, i) => (
      i === packIndex ? { ...pack, feeds: pack.feeds.filter((_, j) => j !== feedIndex) } : pack
    )));
  };
  const handleIconUpload = (file?: File) => {
    if (!file) return;
    if (!file.type.startsWith("image/")) {
      toast.error("Please upload an image file");
      return;
    }
    if (file.size > 180_000) {
      toast.error("Logo must be smaller than 180 KB");
      return;
    }
    const reader = new FileReader();
    reader.onload = () => setSettings({ ...settings, instanceIconDataUrl: String(reader.result || "") });
    reader.readAsDataURL(file);
  };

  return (
    <SettingsModalShell
      open={open}
      onOpenChange={onOpenChange}
      title="Server Management"
      description="Control server-wide settings, users, and integrations."
      activeTab={activeTab}
      onTabChange={setActiveTab}
      tabs={[
        { value: "users", label: "Users", icon: <Users className="w-4 h-4" /> },
        { value: "registrations", label: "Access", icon: <ShieldCheck className="w-4 h-4" /> },
        { value: "email", label: "Email", icon: <Mail className="w-4 h-4" /> },
        { value: "instance", label: "Instance", icon: <Globe className="w-4 h-4" /> },
        { value: "starter-packs", label: "Starter Packs", icon: <PackagePlus className="w-4 h-4" /> },
        { value: "sync", label: "Sync", icon: <Settings2 className="w-4 h-4" /> },
      ]}
    >
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
                    <div className="mb-6 flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
                      <Input
                        placeholder="Search users..."
                        className="h-11 w-full rounded-2xl bg-card border-border/70 sm:max-w-md"
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
                              "flex flex-col gap-4 p-4 rounded-3xl border shadow-sm transition-all hover:border-border sm:flex-row sm:items-center",
                              user.isActive
                                ? "bg-card border-border/60"
                                : "bg-muted/30 border-border/40 opacity-70",
                            )}
                          >
                            <div className="flex w-full min-w-0 items-center gap-3 sm:flex-1">
                              <div className="w-10 h-10 shrink-0 rounded-2xl bg-primary/10 flex items-center justify-center text-primary font-semibold">
                                {user.name?.[0] || user.email?.[0]?.toUpperCase()}
                              </div>
                              <div className="min-w-0 flex-1">
                                <div className="font-semibold truncate flex flex-wrap items-center gap-2 tracking-[-0.01em]">
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
                            </div>
                            <div className="flex w-full justify-end gap-2 sm:w-auto">
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
                <TabsContent value="registrations" className="h-full mt-0 focus-visible:outline-none">
                  <ScrollArea className="h-full">
                    <div className="max-w-2xl space-y-8 px-6 py-6 sm:px-8">
                    <div className="flex flex-col gap-4 p-6 rounded-3xl bg-card border border-border/60 shadow-sm sm:flex-row sm:items-center sm:justify-between">
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
                  </ScrollArea>
                </TabsContent>

                {/* ── EMAIL ── */}
                <TabsContent value="email" className="h-full mt-0 focus-visible:outline-none">
                  <ScrollArea className="h-full">
                    <div className="px-6 sm:px-8 py-6 space-y-6 max-w-2xl">
                      {/* Enable toggle */}
                      <div className="flex flex-col gap-4 p-6 rounded-3xl bg-card border border-border/60 shadow-sm sm:flex-row sm:items-center sm:justify-between">
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
                              <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
                                <SettingsField label="SMTP Host" placeholder="smtp.gmail.com" field="smtpHost" settings={settings} setSettings={setSettings} />
                                <SettingsField label="Port" placeholder="587" field="smtpPort" settings={settings} setSettings={setSettings} type="number" />
                              </div>
                              <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
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

                          <div className="flex flex-col-reverse gap-3 pt-2 sm:flex-row sm:justify-end">
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
                <TabsContent value="instance" className="h-full mt-0 focus-visible:outline-none">
                  <ScrollArea className="h-full">
                    <div className="px-6 py-6 sm:px-8">
                  <div className="max-w-2xl grid gap-6 p-6 rounded-3xl bg-card border border-border/60 shadow-sm">
                    <div className="grid gap-3">
                      <Label>Sidebar logo</Label>
                      <div className="flex flex-col gap-4 sm:flex-row sm:items-center">
                        <div className="flex h-16 w-16 items-center justify-center overflow-hidden rounded-2xl border border-border/70 bg-background/70">
                          {settings?.instanceIconDataUrl ? (
                            // eslint-disable-next-line @next/next/no-img-element
                            <img src={settings.instanceIconDataUrl} alt="Instance logo preview" className="h-full w-full object-cover" />
                          ) : (
                            <ImageIcon className="h-6 w-6 text-muted-foreground" />
                          )}
                        </div>
                        <div className="flex flex-wrap gap-2">
                          <Label className="inline-flex h-10 cursor-pointer items-center rounded-2xl border border-border/70 bg-background/70 px-4 text-sm font-medium hover:bg-muted">
                            Upload icon
                            <Input
                              type="file"
                              accept="image/*"
                              className="hidden"
                              onChange={(event) => handleIconUpload(event.target.files?.[0])}
                            />
                          </Label>
                          {settings?.instanceIconDataUrl && (
                            <Button
                              type="button"
                              variant="outline"
                              className="rounded-2xl"
                              onClick={() => setSettings({ ...settings, instanceIconDataUrl: null })}
                            >
                              Reset
                            </Button>
                          )}
                        </div>
                      </div>
                      <p className="text-xs text-muted-foreground">PNG/SVG/JPEG up to 180 KB. Stored in the database for self-hosted persistence.</p>
                    </div>
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
                          instanceIconDataUrl: settings?.instanceIconDataUrl,
                          totpIssuer: settings?.totpIssuer,
                        })}
                        disabled={isSaving}
                      >
                        {isSaving ? <Loader2 className="w-4 h-4 animate-spin" /> : "Save"}
                      </Button>
                    </div>
                  </div>
                    </div>
                  </ScrollArea>
                </TabsContent>

                {/* ── STARTER PACKS ── */}
                <TabsContent value="starter-packs" className="h-full mt-0 focus-visible:outline-none">
                  <ScrollArea className="h-full">
                    <div className="space-y-4 px-6 py-6 sm:px-8">
                      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
                        <div>
                          <h4 className="text-lg font-semibold tracking-[-0.02em]">Starter Packs</h4>
                          <p className="text-sm text-muted-foreground">
                            Customize the packs users can import from the sidebar.
                          </p>
                        </div>
                        <div className="flex flex-wrap gap-2">
                          <Button type="button" variant="outline" className="rounded-2xl" onClick={() => setStarterPacks(DEFAULT_STARTER_PACKS)}>
                            Reset defaults
                          </Button>
                          <Button type="button" className="rounded-2xl" onClick={addPack}>
                            <Plus className="mr-2 h-4 w-4" /> Add pack
                          </Button>
                        </div>
                      </div>

                      {starterPacks.map((pack, packIndex) => (
                        <div key={pack.id} className="space-y-4 rounded-3xl border border-border/60 bg-card p-5 shadow-sm">
                          <div className="grid gap-3 lg:grid-cols-[1fr_1fr_auto] lg:items-end">
                            <div className="space-y-1.5">
                              <Label>Name</Label>
                              <Input
                                className="rounded-2xl bg-background/70 border-border/70"
                                value={pack.name}
                                onChange={(event) => updatePack(packIndex, { name: event.target.value })}
                              />
                            </div>
                            <div className="space-y-1.5">
                              <Label>Description</Label>
                              <Input
                                className="rounded-2xl bg-background/70 border-border/70"
                                value={pack.description || ""}
                                onChange={(event) => updatePack(packIndex, { description: event.target.value })}
                              />
                            </div>
                            <div className="flex items-center justify-end gap-3">
                              <div className="flex items-center gap-2 rounded-2xl border border-border/60 bg-background/70 px-3 py-2">
                                <span className="text-sm">Enabled</span>
                                <Switch checked={pack.enabled} onCheckedChange={(checked) => updatePack(packIndex, { enabled: checked })} />
                              </div>
                              <Button
                                type="button"
                                variant="ghost"
                                size="icon"
                                className="rounded-xl text-destructive hover:bg-destructive/10"
                                onClick={() => setStarterPacks(starterPacks.filter((_, i) => i !== packIndex))}
                              >
                                <Trash2 className="h-4 w-4" />
                              </Button>
                            </div>
                          </div>

                          {pack.path && (
                            <div className="rounded-2xl border border-amber-500/20 bg-amber-500/10 px-3 py-2 text-xs text-amber-700 dark:text-amber-300">
                              This default pack imports from <code>{pack.path}</code>. Add custom feeds below to override future custom pack content, or remove/reset as needed.
                            </div>
                          )}

                          <div className="space-y-2">
                            <div className="flex items-center justify-between">
                              <Label>Feeds</Label>
                              <Button type="button" size="sm" variant="outline" className="rounded-xl" onClick={() => addPackFeed(packIndex)}>
                                <Plus className="mr-1.5 h-3.5 w-3.5" /> Add feed
                              </Button>
                            </div>
                            <div className="space-y-2">
                              {pack.feeds.map((feed, feedIndex) => (
                                <div key={`${pack.id}-${feedIndex}`} className="grid gap-2 rounded-2xl border border-border/60 bg-background/60 p-3 lg:grid-cols-[1fr_1.4fr_1fr_1fr_auto]">
                                  <Input
                                    placeholder="Title"
                                    className="rounded-xl bg-background/70 border-border/70"
                                    value={feed.title}
                                    onChange={(event) => updatePackFeed(packIndex, feedIndex, { title: event.target.value })}
                                  />
                                  <Input
                                    placeholder="RSS/Atom URL"
                                    className="rounded-xl bg-background/70 border-border/70"
                                    value={feed.xmlUrl}
                                    onChange={(event) => updatePackFeed(packIndex, feedIndex, { xmlUrl: event.target.value })}
                                  />
                                  <Input
                                    placeholder="Website URL"
                                    className="rounded-xl bg-background/70 border-border/70"
                                    value={feed.htmlUrl || ""}
                                    onChange={(event) => updatePackFeed(packIndex, feedIndex, { htmlUrl: event.target.value })}
                                  />
                                  <Input
                                    placeholder="Category"
                                    className="rounded-xl bg-background/70 border-border/70"
                                    value={feed.category || ""}
                                    onChange={(event) => updatePackFeed(packIndex, feedIndex, { category: event.target.value })}
                                  />
                                  <Button type="button" variant="ghost" size="icon" className="rounded-xl text-destructive hover:bg-destructive/10" onClick={() => removePackFeed(packIndex, feedIndex)}>
                                    <X className="h-4 w-4" />
                                  </Button>
                                </div>
                              ))}
                              {pack.feeds.length === 0 && !pack.path && (
                                <div className="rounded-2xl border border-dashed border-border/70 p-4 text-sm text-muted-foreground">
                                  No feeds yet. Add at least one feed before enabling this pack.
                                </div>
                              )}
                            </div>
                          </div>
                        </div>
                      ))}

                      <div className="flex justify-end pb-4">
                        <Button
                          className="rounded-2xl px-8"
                          disabled={isSaving}
                          onClick={() => handleUpdateSettings({ starterPacksJson: stringifyStarterPacks(starterPacks) })}
                        >
                          {isSaving ? <Loader2 className="w-4 h-4 animate-spin" /> : "Save starter packs"}
                        </Button>
                      </div>
                    </div>
                  </ScrollArea>
                </TabsContent>

                {/* ── SYNC ── */}
                <TabsContent value="sync" className="h-full mt-0 focus-visible:outline-none">
                  <ScrollArea className="h-full">
                    <div className="max-w-2xl space-y-6 px-6 py-6 sm:px-8">
                    <div className="flex flex-col gap-4 p-6 rounded-3xl bg-card border border-border/60 shadow-sm sm:flex-row sm:items-center sm:justify-between">
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
                            className="w-full rounded-2xl bg-background/70 border-border/70 sm:w-40"
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
                    <div className="flex flex-col gap-4 p-6 rounded-3xl bg-card border border-border/60 shadow-sm sm:flex-row sm:items-center sm:justify-between">
                      <div className="space-y-1 pr-6">
                        <h4 className="text-lg font-semibold tracking-[-0.02em]">Trusted internal feed URLs</h4>
                        <p className="text-sm text-muted-foreground">
                          Allow feed fetches to private IPs, localhost, and internal network hosts. Keep this off for public multi-user instances.
                        </p>
                      </div>
                      <Switch
                        checked={settings?.allowInternalFeedUrls ?? false}
                        onCheckedChange={(checked) => handleUpdateSettings({ allowInternalFeedUrls: checked })}
                      />
                    </div>
                    {settings?.allowInternalFeedUrls && (
                      <div className="p-6 rounded-3xl bg-destructive/10 border border-destructive/20 space-y-2">
                        <div className="flex items-center gap-2 text-destructive">
                          <AlertCircle className="w-5 h-5" />
                          <h4 className="font-bold">Internal URL fetching enabled</h4>
                        </div>
                        <p className="text-sm text-destructive/80 leading-relaxed">
                          Users can now add feeds that resolve to private/internal network addresses. Only enable this on trusted single-tenant deployments.
                        </p>
                      </div>
                    )}
                    </div>
                  </ScrollArea>
                </TabsContent>
              </>
            )}
          </div>

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
    </SettingsModalShell>
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
