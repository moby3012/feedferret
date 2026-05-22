"use client";

import { useState, useEffect } from "react";
import { useTranslations, useFormatter } from "next-intl";
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
import { SettingsModalShell, SettingsPageShell } from "@/components/settings-shell";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Empty, EmptyMedia, EmptyTitle, EmptyDescription, EmptyContent } from "@/components/ui/empty";
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
  Download,
  Upload,
  ArrowUp,
  ArrowDown,
  Copy,
  Compass,
  Bell,
  KeyRound,
  ClipboardCopy,
  CheckCircle2,
  AlertTriangle,
  HardDrive,
  FileText,
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
  getPushDiagnostics,
  generateVapidKeyPair,
  getAdminAuditLog,
  getLoginAttempts,
  getStorageStats,
  getSystemLogs,
} from "@/app/actions/admin";

type AdminUser = Awaited<ReturnType<typeof getUsers>>[number];
type GlobalSettings = Awaited<ReturnType<typeof getGlobalSettings>>;
type AuditLogEntry = Awaited<ReturnType<typeof getAdminAuditLog>>[number];
type LoginAttempt = Awaited<ReturnType<typeof getLoginAttempts>>[number];
type StorageStat = Awaited<ReturnType<typeof getStorageStats>>[number];
type SystemLogEntry = Awaited<ReturnType<typeof getSystemLogs>>[number];
import { toast } from "sonner";
import {
  DEFAULT_STARTER_PACKS,
  normalizeStarterPacksInput,
  starterPackToOpml,
  stringifyStarterPacks,
  type StarterPack,
  type StarterPackFeed,
} from "@/lib/starter-packs";

export function ServerManagementDialog({
  open,
  onOpenChange,
  pageMode = false,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  pageMode?: boolean;
}) {
  const t = useTranslations("serverManagement");
  const format = useFormatter();
  const [users, setUsers] = useState<AdminUser[]>([]);
  const [settings, setSettings] = useState<GlobalSettings | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [isSaving, setIsSaving] = useState(false);
  const [searchQuery, setSearchQuery] = useState("");
  const [pendingDeleteUser, setPendingDeleteUser] = useState<AdminUser | null>(null);
  const [activeTab, setActiveTab] = useState("users");
  const [auditLog, setAuditLog] = useState<AuditLogEntry[]>([]);
  const [loginAttempts, setLoginAttempts] = useState<LoginAttempt[]>([]);
  const [auditLoaded, setAuditLoaded] = useState(false);
  const [storageStats, setStorageStats] = useState<StorageStat[]>([]);
  const [storageLoaded, setStorageLoaded] = useState(false);
  const [systemLogs, setSystemLogs] = useState<SystemLogEntry[]>([]);
  const [logsLoaded, setLogsLoaded] = useState(false);
  const [logsCategory, setLogsCategory] = useState<string | undefined>(undefined);

  const loadData = async () => {
    setIsLoading(true);
    try {
      const [allUsers, globalSettings] = await Promise.all([getUsers(), getGlobalSettings()]);
      setUsers(allUsers);
      setSettings(globalSettings);
    } catch {
      toast.error(t("toast.failedToLoadServerData"));
    } finally {
      setIsLoading(false);
    }
  };

  const loadAuditData = async () => {
    if (auditLoaded) return;
    try {
      const [log, attempts] = await Promise.all([getAdminAuditLog(), getLoginAttempts()]);
      setAuditLog(log);
      setLoginAttempts(attempts);
      setAuditLoaded(true);
    } catch {
      toast.error(t("toast.failedToLoadAuditData"));
    }
  };

  const loadStorageStats = async () => {
    if (storageLoaded) return;
    try {
      const stats = await getStorageStats();
      setStorageStats(stats);
      setStorageLoaded(true);
    } catch {
      toast.error(t("toast.failedToLoadStorageStats"));
    }
  };

  const loadSystemLogs = async (category?: string) => {
    try {
      const logs = await getSystemLogs(200, category);
      setSystemLogs(logs);
      setLogsLoaded(true);
    } catch {
      toast.error(t("toast.failedToLoadSystemLogs"));
    }
  };

  useEffect(() => {
    if (open) loadData();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  const handleUpdateSettings = async (newData: any) => {
    setIsSaving(true);
    try {
      await updateGlobalSettings(newData);
      setSettings((prev: any) => ({ ...prev, ...newData }));
      toast.success(t("toast.settingsSaved"));
    } catch (error: any) {
      toast.error(error?.message || t("toast.failedToUpdateSettings"));
    } finally {
      setIsSaving(false);
    }
  };

  const handleSendTestEmail = async () => {
    setIsSaving(true);
    try {
      const result = await sendTestEmail(settings);
      if (result.success) {
        toast.success(t("toast.testEmailSent", { email: result.sentTo ?? "" }));
      } else {
        toast.error(t("toast.mailTestFailed", { error: result.error ?? "" }));
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
      toast.success(t("toast.userRoleUpdated", { email: user.email, role: newRole }));
    } catch (error: any) {
      toast.error(error?.message || t("toast.failedToUpdateUserRole"));
    }
  };

  const handleToggleSuspend = async (user: any) => {
    try {
      if (user.isActive) {
        await suspendUser(user.id);
        setUsers(users.map((u) => (u.id === user.id ? { ...u, isActive: false } : u)));
        toast.success(t("toast.userSuspended", { email: user.email }));
      } else {
        await unsuspendUser(user.id);
        setUsers(users.map((u) => (u.id === user.id ? { ...u, isActive: true } : u)));
        toast.success(t("toast.userReactivated", { email: user.email }));
      }
    } catch {
      toast.error(t("toast.failedToUpdateUserStatus"));
    }
  };

  const handleDeleteUser = async (userId: string) => {
    try {
      await deleteUser(userId);
      setUsers(users.filter((u) => u.id !== userId));
      toast.success(t("toast.userDeleted"));
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
  const starterPackValidation = normalizeStarterPacksInput(starterPacks);
  const setStarterPacks = (packs: StarterPack[]) => {
    setSettings({ ...settings, starterPacks: packs, starterPacksJson: JSON.stringify(packs, null, 2) });
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
  const resetStarterPacks = async () => {
    try {
      const response = await fetch("/api/starter-packs?defaults=1");
      const data = response.ok ? await response.json() : null;
      setStarterPacks(Array.isArray(data?.packs) ? data.packs : DEFAULT_STARTER_PACKS);
    } catch {
      setStarterPacks(DEFAULT_STARTER_PACKS);
    }
  };
  const duplicatePack = (packIndex: number) => {
    const pack = starterPacks[packIndex];
    if (!pack) return;
    setStarterPacks([
      ...starterPacks.slice(0, packIndex + 1),
      { ...pack, id: `${pack.id}-copy-${Date.now()}`, name: `${pack.name} copy`, path: undefined },
      ...starterPacks.slice(packIndex + 1),
    ]);
  };
  const movePack = (from: number, to: number) => {
    if (to < 0 || to >= starterPacks.length) return;
    const next = [...starterPacks];
    const [pack] = next.splice(from, 1);
    next.splice(to, 0, pack);
    setStarterPacks(next);
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
  const movePackFeed = (packIndex: number, from: number, to: number) => {
    const pack = starterPacks[packIndex];
    if (!pack || to < 0 || to >= pack.feeds.length) return;
    const feeds = [...pack.feeds];
    const [feed] = feeds.splice(from, 1);
    feeds.splice(to, 0, feed);
    updatePack(packIndex, { feeds });
  };
  const importOpmlIntoPack = async (packIndex: number, file?: File) => {
    if (!file) return;
    try {
      const xml = await file.text();
      const document = new DOMParser().parseFromString(xml, "text/xml");
      if (document.querySelector("parsererror")) throw new Error("Invalid OPML/XML file");
      const readOutlines = (elements: Element[], category = ""): StarterPackFeed[] =>
        elements.flatMap((element) => {
          const xmlUrl = element.getAttribute("xmlUrl") || "";
          const nextCategory = element.getAttribute("category") || category;
          if (xmlUrl) {
            return [{
              title: element.getAttribute("text") || element.getAttribute("title") || xmlUrl,
              xmlUrl,
              htmlUrl: element.getAttribute("htmlUrl") || "",
              category: nextCategory,
            }];
          }
          return readOutlines(
            Array.from(element.children).filter((child) => child.tagName.toLowerCase() === "outline"),
            element.getAttribute("text") || element.getAttribute("title") || category,
          );
        });
      const feeds = readOutlines(Array.from(document.querySelectorAll("body > outline")));
      if (feeds.length === 0) throw new Error("No feeds found in OPML");
      const current = starterPacks[packIndex]?.feeds || [];
      const merged = [...current, ...feeds].filter((feed, index, all) => (
        all.findIndex((candidate) => candidate.xmlUrl.trim().toLowerCase() === feed.xmlUrl.trim().toLowerCase()) === index
      ));
      updatePack(packIndex, { feeds: merged, path: undefined });
      toast.success(t("toast.opmlImported", { count: feeds.length }));
    } catch (error: any) {
      toast.error(error?.message || t("toast.opmlImportFailed"));
    }
  };
  const exportStarterPack = (pack: StarterPack) => {
    const xml = starterPackToOpml(pack);
    const blob = new Blob([xml], { type: "text/xml;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = `${pack.id || "starter-pack"}.opml`;
    link.click();
    URL.revokeObjectURL(url);
  };
  const saveStarterPacks = async () => {
    const result = normalizeStarterPacksInput(starterPacks);
    if (result.errors.length > 0) {
      toast.error(result.errors[0]);
      return;
    }
    setStarterPacks(result.packs);
    if (result.warnings.length > 0) toast.info(result.warnings[0]);
    await handleUpdateSettings({ starterPacksJson: stringifyStarterPacks(result.packs) });
  };
  const handleIconUpload = (file?: File) => {
    if (!file) return;
    if (!file.type.startsWith("image/")) {
      toast.error(t("toast.invalidImageFile"));
      return;
    }
    if (file.size > 180_000) {
      toast.error(t("toast.logoTooLarge"));
      return;
    }
    const reader = new FileReader();
    reader.onload = () => setSettings({ ...settings, instanceIconDataUrl: String(reader.result || "") });
    reader.readAsDataURL(file);
  };

  const shellTabs = [
    { value: "users", label: t("tabs.users"), icon: <Users className="w-4 h-4" /> },
    { value: "registrations", label: t("tabs.registrations"), icon: <ShieldCheck className="w-4 h-4" /> },
    { value: "email", label: t("tabs.email"), icon: <Mail className="w-4 h-4" /> },
    { value: "notifications", label: t("tabs.notifications"), icon: <Bell className="w-4 h-4" /> },
    { value: "instance", label: t("tabs.instance"), icon: <Globe className="w-4 h-4" /> },
    { value: "starter-packs", label: t("tabs.starterPacks"), icon: <PackagePlus className="w-4 h-4" /> },
    { value: "sync", label: t("tabs.sync"), icon: <Settings2 className="w-4 h-4" /> },
    { value: "discovery", label: t("tabs.discovery"), icon: <Compass className="w-4 h-4" /> },
    { value: "audit", label: t("tabs.audit"), icon: <Shield className="w-4 h-4" />, onSelect: loadAuditData },
    { value: "storage", label: t("tabs.storage"), icon: <HardDrive className="w-4 h-4" />, onSelect: loadStorageStats },
    { value: "logs", label: t("tabs.logs"), icon: <FileText className="h-4 w-4" />, onSelect: () => loadSystemLogs(undefined) },
  ];

  const shellProps = {
    title: t("title"),
    description: t("title"),
    activeTab,
    onTabChange: (tab: string) => {
      setActiveTab(tab);
      const found = shellTabs.find((t) => t.value === tab);
      if (found && "onSelect" in found && typeof found.onSelect === "function") found.onSelect();
    },
    tabs: shellTabs,
  };

  const body = (
    <>
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
                        placeholder={t("users.searchPlaceholder")}
                        className="h-11 w-full rounded-2xl bg-card border-border/70 sm:max-w-md"
                        value={searchQuery}
                        onChange={(e) => setSearchQuery(e.target.value)}
                      />
                    </div>
                    <ScrollArea className="flex-1">
                      <div className="space-y-3 pb-8">
                        {filteredUsers.length === 0 && (
                          <Empty className="border-0">
                            <EmptyMedia variant="icon"><Users className="size-5" /></EmptyMedia>
                            <EmptyContent>
                              <EmptyTitle>{t("users.noUsersFound")}</EmptyTitle>
                              <EmptyDescription>{t("users.tryDifferentSearch")}</EmptyDescription>
                            </EmptyContent>
                          </Empty>
                        )}
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
                                  {user.name || t("users.unnamedUser")}
                                  {user.role === "ADMIN" && (
                                    <span className="text-[10px] bg-primary/10 text-primary px-1.5 py-0.5 rounded-full font-bold">
                                      {t("users.adminBadge")}
                                    </span>
                                  )}
                                  {!user.isActive && (
                                    <span className="text-[10px] bg-destructive/10 text-destructive px-1.5 py-0.5 rounded-full font-bold">
                                      {t("users.suspendedBadge")}
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
                                title={user.role === "ADMIN" ? t("users.removeAdmin") : t("users.makeAdmin")}
                              >
                                {user.role === "ADMIN" ? <ShieldCheck className="w-4 h-4" /> : <Shield className="w-4 h-4" />}
                              </Button>
                              <Button
                                size="sm"
                                variant="ghost"
                                className={cn("rounded-lg transition-colors", user.isActive ? "text-amber-500 hover:bg-amber-500/10" : "text-emerald-500 hover:bg-emerald-500/10")}
                                onClick={() => handleToggleSuspend(user)}
                                title={user.isActive ? t("users.suspendUser") : t("users.reactivateUser")}
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
                        <h4 className="text-lg font-semibold tracking-[-0.02em]">{t("registrations.allowNewRegistrations")}</h4>
                        <p className="text-sm text-muted-foreground">
                          {t("registrations.registrationsDescription")}
                        </p>
                      </div>
                      <Switch
                        checked={settings?.registrationsEnabled ?? true}
                        onCheckedChange={(checked) => handleUpdateSettings({ registrationsEnabled: checked })}
                      />
                    </div>
                    <div className="flex flex-col gap-4 p-6 rounded-3xl bg-card border border-border/60 shadow-sm sm:flex-row sm:items-center sm:justify-between">
                      <div className="space-y-1">
                        <h4 className="text-lg font-semibold tracking-[-0.02em]">{t("registrations.require2FA")}</h4>
                        <p className="text-sm text-muted-foreground">
                          {t("registrations.require2FADescription")}
                        </p>
                      </div>
                      <Switch
                        checked={settings?.require2FAForAdmins ?? false}
                        onCheckedChange={(checked) => handleUpdateSettings({ require2FAForAdmins: checked })}
                      />
                    </div>
                    <div className="flex flex-col gap-4 p-6 rounded-3xl bg-card border border-border/60 shadow-sm sm:flex-row sm:items-center sm:justify-between">
                      <div className="space-y-1">
                        <h4 className="text-lg font-semibold tracking-[-0.02em]">{t("registrations.publicSavedSearches")}</h4>
                        <p className="text-sm text-muted-foreground">
                          {t("registrations.publicSavedSearchesDescription")}
                        </p>
                      </div>
                      <Switch
                        checked={!(settings?.disablePublicSharedSearches ?? false)}
                        onCheckedChange={(checked) => handleUpdateSettings({ disablePublicSharedSearches: !checked })}
                      />
                    </div>
                    <div className="flex flex-col gap-4 p-6 rounded-3xl bg-card border border-border/60 shadow-sm sm:flex-row sm:items-center sm:justify-between">
                      <div className="space-y-1">
                        <h4 className="text-lg font-semibold tracking-[-0.02em]">{t("registrations.defaultUiLanguage")}</h4>
                        <p className="text-sm text-muted-foreground">
                          {t("registrations.defaultUiLanguageDescription")}
                        </p>
                      </div>
                      <Select
                        value={settings?.defaultUiLanguage ?? "en"}
                        onValueChange={(value) => handleUpdateSettings({ defaultUiLanguage: value })}
                      >
                        <SelectTrigger className="w-40 rounded-2xl bg-background/70 border-border/70">
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent className="rounded-2xl">
                          <SelectItem value="en">English</SelectItem>
                          <SelectItem value="de">Deutsch</SelectItem>
                        </SelectContent>
                      </Select>
                    </div>
                    <div className="p-6 rounded-3xl bg-amber-500/10 border border-amber-500/20 space-y-3">
                      <div className="flex items-center gap-2 text-amber-500">
                        <AlertCircle className="w-5 h-5" />
                        <h4 className="font-bold">{t("registrations.securityNote")}</h4>
                      </div>
                      <p className="text-sm text-amber-500/80 leading-relaxed">
                        {t("registrations.disableRegistrations")}
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
                          <h4 className="text-lg font-semibold tracking-[-0.02em]">{t("email.mailService")}</h4>
                          <p className="text-sm text-muted-foreground">
                            {t("email.enableMailService")}
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
                            <Label>{t("email.emailProvider")}</Label>
                            <Select
                              value={settings.mailProvider || "smtp"}
                              onValueChange={(value) => setSettings({ ...settings, mailProvider: value })}
                            >
                              <SelectTrigger className="rounded-2xl bg-background/70 border-border/70">
                                <SelectValue placeholder={t("email.chooseProvider")} />
                              </SelectTrigger>
                              <SelectContent className="rounded-2xl">
                                <SelectItem value="smtp">{t("email.smtp")}</SelectItem>
                                <SelectItem value="resend">{t("email.resend")}</SelectItem>
                                <SelectItem value="postmark">{t("email.postmark")}</SelectItem>
                                <SelectItem value="mailgun">{t("email.mailgun")}</SelectItem>
                                <SelectItem value="sendgrid">{t("email.sendgrid")}</SelectItem>
                              </SelectContent>
                            </Select>
                          </div>

                          {/* SMTP fields */}
                          {settings.mailProvider === "smtp" && (
                            <>
                              <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
                                <SettingsField label={t("email.smtpHost")} placeholder="smtp.gmail.com" field="smtpHost" settings={settings} setSettings={setSettings} />
                                <SettingsField label={t("email.smtpPort")} placeholder="587" field="smtpPort" settings={settings} setSettings={setSettings} type="number" />
                              </div>
                              <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
                                <SettingsField label={t("email.smtpUsername")} placeholder="user@gmail.com" field="smtpUser" settings={settings} setSettings={setSettings} />
                                <SettingsField label={t("email.smtpPassword")} placeholder="••••••••" field="smtpPassword" settings={settings} setSettings={setSettings} type="password" isSecret />
                              </div>
                              <SettingsField label={t("email.smtpFromEmail")} placeholder="noreply@feedferret.cloud" field="smtpFrom" settings={settings} setSettings={setSettings} />
                              <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
                                <div className="space-y-2">
                                  <Label>{t("email.smtpSecurity")}</Label>
                                  <Select
                                    value={settings.smtpSecure ?? "auto"}
                                    onValueChange={(val) => setSettings({ ...settings, smtpSecure: val === "auto" ? null : val })}
                                  >
                                    <SelectTrigger className="rounded-2xl bg-background/70 border-border/70">
                                      <SelectValue />
                                    </SelectTrigger>
                                    <SelectContent className="rounded-2xl">
                                      <SelectItem value="auto">{t("email.smtpSecureAuto")}</SelectItem>
                                      <SelectItem value="ssl">{t("email.smtpSecureSsl")}</SelectItem>
                                      <SelectItem value="starttls">{t("email.smtpSecureStarttls")}</SelectItem>
                                      <SelectItem value="plain">{t("email.smtpSecurePlain")}</SelectItem>
                                    </SelectContent>
                                  </Select>
                                </div>
                                <div className="flex items-center gap-3 pt-7">
                                  <Switch
                                    checked={settings.smtpRejectUnauthorized === false}
                                    onCheckedChange={(checked) => setSettings({ ...settings, smtpRejectUnauthorized: checked ? false : null })}
                                  />
                                  <Label>{t("email.smtpAllowSelfSigned")}</Label>
                                </div>
                              </div>
                            </>
                          )}

                          {/* Resend fields */}
                          {settings.mailProvider === "resend" && (
                            <>
                              <SettingsField label={t("email.apiKey")} placeholder="re_…" field="resendApiKey" settings={settings} setSettings={setSettings} type="password" isSecret />
                              <SettingsField label={t("email.fromEmail")} placeholder="FeedFerret <noreply@example.com>" field="resendFromEmail" settings={settings} setSettings={setSettings} />
                            </>
                          )}

                          {/* Postmark fields */}
                          {settings.mailProvider === "postmark" && (
                            <>
                              <SettingsField label={t("email.serverToken")} placeholder="xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx" field="postmarkServerToken" settings={settings} setSettings={setSettings} type="password" isSecret />
                              <SettingsField label={t("email.fromEmail")} placeholder="noreply@example.com" field="postmarkFromEmail" settings={settings} setSettings={setSettings} />
                              <SettingsField label={t("email.messageStream")} placeholder="outbound" field="postmarkMessageStream" settings={settings} setSettings={setSettings} />
                            </>
                          )}

                          {/* Mailgun fields */}
                          {settings.mailProvider === "mailgun" && (
                            <>
                              <SettingsField label={t("email.apiKey")} placeholder="key-…" field="mailgunApiKey" settings={settings} setSettings={setSettings} type="password" isSecret />
                              <SettingsField label={t("email.domain")} placeholder="mg.example.com" field="mailgunDomain" settings={settings} setSettings={setSettings} />
                              <SettingsField label={t("email.fromEmail")} placeholder="FeedFerret <noreply@example.com>" field="mailgunFromEmail" settings={settings} setSettings={setSettings} />
                              <SettingsField label={t("email.baseUrl")} placeholder="https://api.eu.mailgun.net" field="mailgunBaseUrl" settings={settings} setSettings={setSettings} />
                            </>
                          )}

                          {/* SendGrid fields */}
                          {settings.mailProvider === "sendgrid" && (
                            <>
                              <SettingsField label={t("email.apiKey")} placeholder="SG.…" field="sendgridApiKey" settings={settings} setSettings={setSettings} type="password" isSecret />
                              <SettingsField label={t("email.fromEmail")} placeholder="noreply@example.com" field="sendgridFromEmail" settings={settings} setSettings={setSettings} />
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
                              {t("email.sendTestEmail")}
                            </Button>
                            <Button
                              className="rounded-2xl px-8"
                              onClick={() => handleUpdateSettings(settings)}
                              disabled={isSaving}
                            >
                              {isSaving ? <Loader2 className="w-4 h-4 animate-spin" /> : t("email.save")}
                            </Button>
                          </div>
                        </div>
                      )}
                    </div>
                  </ScrollArea>
                </TabsContent>

                {/* ── NOTIFICATIONS ── */}
                <TabsContent value="notifications" className="h-full mt-0 focus-visible:outline-none">
                  <ScrollArea className="h-full">
                    <div className="px-6 py-6 sm:px-8 max-w-2xl">
                      <NotificationsAdminPanel />
                    </div>
                  </ScrollArea>
                </TabsContent>

                {/* ── INSTANCE ── */}
                <TabsContent value="instance" className="h-full mt-0 focus-visible:outline-none">
                  <ScrollArea className="h-full">
                    <div className="px-6 py-6 sm:px-8">
                  <div className="max-w-2xl grid gap-6 p-6 rounded-3xl bg-card border border-border/60 shadow-sm">
                    <div className="grid gap-3">
                      <Label>{t("instance.sidebarLogo")}</Label>
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
                            {t("instance.uploadIcon")}
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
                              {t("instance.reset")}
                            </Button>
                          )}
                        </div>
                      </div>
                      <p className="text-xs text-muted-foreground">{t("instance.logoDescription")}</p>
                    </div>
                    <SettingsField
                      label={t("instance.instanceName")}
                      placeholder="FeedFerret"
                      field="instanceName"
                      settings={settings}
                      setSettings={setSettings}
                    />
                    <SettingsField
                      label={t("instance.publicUrl")}
                      placeholder="https://rss.example.com"
                      field="instanceUrl"
                      settings={settings}
                      setSettings={setSettings}
                    />
                    <SettingsField
                      label={t("instance.authenticatorLabel")}
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
                        {isSaving ? <Loader2 className="w-4 h-4 animate-spin" /> : t("instance.save")}
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
                          <h4 className="text-lg font-semibold tracking-[-0.02em]">{t("starterPacks.title")}</h4>
                          <p className="text-sm text-muted-foreground">
                            {t("starterPacks.description")}
                          </p>
                        </div>
                        <div className="flex flex-wrap gap-2">
                          <Button type="button" variant="outline" className="rounded-2xl" onClick={resetStarterPacks}>
                            {t("starterPacks.resetDefaults")}
                          </Button>
                          <Button type="button" className="rounded-2xl" onClick={addPack}>
                            <Plus className="me-2 h-4 w-4" /> {t("starterPacks.addPack")}
                          </Button>
                        </div>
                      </div>

                      {(starterPackValidation.errors.length > 0 || starterPackValidation.warnings.length > 0) && (
                        <div className={cn(
                          "rounded-2xl border px-4 py-3 text-sm",
                          starterPackValidation.errors.length > 0
                            ? "border-destructive/25 bg-destructive/10 text-destructive"
                            : "border-amber-500/20 bg-amber-500/10 text-amber-700 dark:text-amber-300",
                        )}>
                          <p className="font-semibold">
                            {starterPackValidation.errors.length > 0 ? "Starter pack validation needs attention" : "Starter pack cleanup will be applied on save"}
                          </p>
                          <ul className="mt-2 list-disc space-y-1 ps-5">
                            {[...starterPackValidation.errors, ...starterPackValidation.warnings].slice(0, 4).map((message) => (
                              <li key={message}>{message}</li>
                            ))}
                          </ul>
                        </div>
                      )}

                      {starterPacks.map((pack, packIndex) => (
                        <div key={pack.id} className="space-y-4 rounded-3xl border border-border/60 bg-card p-5 shadow-sm">
                          <div className="grid gap-3 lg:grid-cols-[1fr_1fr_auto] lg:items-end">
                            <div className="space-y-1.5">
                              <Label>{t("starterPacks.name")}</Label>
                              <Input
                                className="rounded-2xl bg-background/70 border-border/70"
                                value={pack.name}
                                onChange={(event) => updatePack(packIndex, { name: event.target.value })}
                              />
                            </div>
                            <div className="space-y-1.5">
                              <Label>{t("starterPacks.description")}</Label>
                              <Input
                                className="rounded-2xl bg-background/70 border-border/70"
                                value={pack.description || ""}
                                onChange={(event) => updatePack(packIndex, { description: event.target.value })}
                              />
                            </div>
                            <div className="flex items-center justify-end gap-3">
                              <div className="flex items-center gap-1">
                                <Button type="button" variant="ghost" size="icon" className="rounded-xl" disabled={packIndex === 0} onClick={() => movePack(packIndex, packIndex - 1)}>
                                  <ArrowUp className="h-4 w-4" />
                                </Button>
                                <Button type="button" variant="ghost" size="icon" className="rounded-xl" disabled={packIndex === starterPacks.length - 1} onClick={() => movePack(packIndex, packIndex + 1)}>
                                  <ArrowDown className="h-4 w-4" />
                                </Button>
                              </div>
                              <div className="flex items-center gap-2 rounded-2xl border border-border/60 bg-background/70 px-3 py-2">
                                <span className="text-sm">{t("starterPacks.enabled")}</span>
                                <Switch checked={pack.enabled} onCheckedChange={(checked) => updatePack(packIndex, { enabled: checked })} />
                              </div>
                              <Button
                                type="button"
                                variant="ghost"
                                size="icon"
                                className="rounded-xl"
                                onClick={() => duplicatePack(packIndex)}
                                title={t("starterPacks.duplicatePack")}
                              >
                                <Copy className="h-4 w-4" />
                              </Button>
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
                            <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
                              <Label>{t("starterPacks.feeds")} ({pack.feeds.length})</Label>
                              <div className="flex flex-wrap gap-2">
                                <Label className="inline-flex h-9 cursor-pointer items-center rounded-xl border border-border/70 bg-background/70 px-3 text-sm font-medium hover:bg-muted">
                                  <Upload className="me-1.5 h-3.5 w-3.5" /> {t("starterPacks.importOpml")}
                                  <Input
                                    type="file"
                                    accept=".opml,.xml,text/xml,application/xml"
                                    className="hidden"
                                    onChange={(event) => {
                                      importOpmlIntoPack(packIndex, event.target.files?.[0]);
                                      event.currentTarget.value = "";
                                    }}
                                  />
                                </Label>
                                <Button type="button" size="sm" variant="outline" className="rounded-xl" onClick={() => exportStarterPack(pack)} disabled={pack.feeds.length === 0}>
                                  <Download className="me-1.5 h-3.5 w-3.5" /> {t("starterPacks.export")}
                                </Button>
                                <Button type="button" size="sm" variant="outline" className="rounded-xl" onClick={() => addPackFeed(packIndex)}>
                                  <Plus className="me-1.5 h-3.5 w-3.5" /> {t("starterPacks.addFeed")}
                                </Button>
                              </div>
                            </div>
                            <div className="space-y-2">
                              {pack.feeds.map((feed, feedIndex) => (
                                <div key={`${pack.id}-${feedIndex}`} className="grid gap-2 rounded-2xl border border-border/60 bg-background/60 p-3 lg:grid-cols-[auto_1fr_1.4fr_1fr_1fr_auto]">
                                  <div className="flex gap-1 lg:flex-col">
                                    <Button type="button" variant="ghost" size="icon" className="h-8 w-8 rounded-xl" disabled={feedIndex === 0} onClick={() => movePackFeed(packIndex, feedIndex, feedIndex - 1)}>
                                      <ArrowUp className="h-3.5 w-3.5" />
                                    </Button>
                                    <Button type="button" variant="ghost" size="icon" className="h-8 w-8 rounded-xl" disabled={feedIndex === pack.feeds.length - 1} onClick={() => movePackFeed(packIndex, feedIndex, feedIndex + 1)}>
                                      <ArrowDown className="h-3.5 w-3.5" />
                                    </Button>
                                  </div>
                                  <Input
                                    placeholder={t("starterPacks.feedTitle")}
                                    className="rounded-xl bg-background/70 border-border/70"
                                    value={feed.title}
                                    onChange={(event) => updatePackFeed(packIndex, feedIndex, { title: event.target.value })}
                                  />
                                  <Input
                                    placeholder={t("starterPacks.feedUrl")}
                                    className="rounded-xl bg-background/70 border-border/70"
                                    value={feed.xmlUrl}
                                    onChange={(event) => updatePackFeed(packIndex, feedIndex, { xmlUrl: event.target.value })}
                                  />
                                  <Input
                                    placeholder={t("starterPacks.feedWebsiteUrl")}
                                    className="rounded-xl bg-background/70 border-border/70"
                                    value={feed.htmlUrl || ""}
                                    onChange={(event) => updatePackFeed(packIndex, feedIndex, { htmlUrl: event.target.value })}
                                  />
                                  <Input
                                    placeholder={t("starterPacks.feedCategory")}
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
                                  {t("starterPacks.noFeedsYet")}
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
                          onClick={saveStarterPacks}
                        >
                          {isSaving ? <Loader2 className="w-4 h-4 animate-spin" /> : t("starterPacks.saveStarterPacks")}
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
                        <h4 className="text-lg font-semibold tracking-[-0.02em]">{t("sync.backgroundSync")}</h4>
                        <p className="text-sm text-muted-foreground">
                          {t("sync.automaticallyFetch")}
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
                          <Label>{t("sync.syncInterval")}</Label>
                          <Input
                            type="number"
                            min={1}
                            max={1440}
                            className="w-full rounded-2xl bg-background/70 border-border/70 sm:w-40"
                            value={settings?.backgroundSyncIntervalMinutes ?? 5}
                            onChange={(e) => {
                              const v = parseInt(e.target.value);
                              setSettings({ ...settings, backgroundSyncIntervalMinutes: Number.isFinite(v) && v >= 1 ? v : 1 });
                            }}
                          />
                          <p className="text-xs text-muted-foreground">{t("sync.minOneMinute")}</p>
                        </div>
                        <div className="flex justify-end">
                          <Button
                            className="rounded-2xl px-8"
                            onClick={() => handleUpdateSettings({ backgroundSyncIntervalMinutes: settings?.backgroundSyncIntervalMinutes })}
                            disabled={isSaving}
                          >
                            {isSaving ? <Loader2 className="w-4 h-4 animate-spin" /> : t("sync.save")}
                          </Button>
                        </div>
                      </div>
                    )}
                    <div className="flex flex-col gap-4 p-6 rounded-3xl bg-card border border-border/60 shadow-sm sm:flex-row sm:items-center sm:justify-between">
                      <div className="space-y-1 pe-6">
                        <h4 className="text-lg font-semibold tracking-[-0.02em]">{t("sync.trustedInternalFeeds")}</h4>
                        <p className="text-sm text-muted-foreground">
                          {t("sync.allowInternalIps")}
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
                          <h4 className="font-bold">{t("sync.internalUrlFetching")}</h4>
                        </div>
                        <p className="text-sm text-destructive/80 leading-relaxed">
                          {t("sync.internalUrlWarning")}
                        </p>
                      </div>
                    )}
                    </div>
                  </ScrollArea>
                </TabsContent>

                {/* ── DISCOVERY CATALOG ── */}
                <TabsContent value="discovery" className="h-full mt-0 focus-visible:outline-none">
                  <DiscoveryCatalogTab />
                </TabsContent>

                {/* ── AUDIT LOG ── */}
                <TabsContent value="audit" className="h-full mt-0 focus-visible:outline-none">
                  <ScrollArea className="h-full">
                    <div className="px-6 sm:px-8 py-6 max-w-4xl space-y-8">
                      {/* Admin Actions */}
                      <div>
                        <h3 className="text-base font-semibold mb-4">{t("audit.adminActions")}</h3>
                        {auditLog.length === 0 ? (
                          <p className="text-sm text-muted-foreground">{t("audit.noAdminActionsRecorded")}</p>
                        ) : (
                          <div className="rounded-2xl border border-border/60 overflow-hidden">
                            <table className="w-full text-sm">
                              <thead className="bg-muted/40">
                                <tr>
                                  <th className="text-start px-4 py-2 font-medium text-muted-foreground">{t("audit.time")}</th>
                                  <th className="text-start px-4 py-2 font-medium text-muted-foreground">{t("audit.actor")}</th>
                                  <th className="text-start px-4 py-2 font-medium text-muted-foreground">{t("audit.action")}</th>
                                  <th className="text-start px-4 py-2 font-medium text-muted-foreground">{t("audit.target")}</th>
                                </tr>
                              </thead>
                              <tbody>
                                {auditLog.map((entry, i) => (
                                  <tr key={entry.id} className={cn("border-t border-border/40", i % 2 === 0 ? "" : "bg-muted/20")}>
                                    <td className="px-4 py-2 text-muted-foreground whitespace-nowrap">{new Date(entry.createdAt).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" })}</td>
                                    <td className="px-4 py-2 truncate max-w-[140px]">{entry.actor?.name || entry.actor?.email || "—"}</td>
                                    <td className="px-4 py-2">
                                      <span className={cn("inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium", {
                                        "bg-destructive/15 text-destructive": entry.action === "user.delete",
                                        "bg-amber-500/15 text-amber-600": entry.action === "user.suspend" || entry.action === "user.role_change",
                                        "bg-green-500/15 text-green-600": entry.action === "user.unsuspend",
                                        "bg-blue-500/15 text-blue-600": entry.action === "settings.update",
                                        "bg-muted text-muted-foreground": !["user.delete","user.suspend","user.role_change","user.unsuspend","settings.update"].includes(entry.action),
                                      })}>
                                        {entry.action}
                                      </span>
                                    </td>
                                    <td className="px-4 py-2 text-muted-foreground truncate max-w-[160px]">{entry.targetEmail || entry.targetId || "—"}</td>
                                  </tr>
                                ))}
                              </tbody>
                            </table>
                          </div>
                        )}
                      </div>

                      {/* Login Attempts */}
                      <div>
                        <h3 className="text-base font-semibold mb-4">{t("audit.recentLoginAttempts")}</h3>
                        {loginAttempts.length === 0 ? (
                          <p className="text-sm text-muted-foreground">{t("audit.noLoginAttemptsRecorded")}</p>
                        ) : (
                          <div className="rounded-2xl border border-border/60 overflow-hidden">
                            <table className="w-full text-sm">
                              <thead className="bg-muted/40">
                                <tr>
                                  <th className="text-start px-4 py-2 font-medium text-muted-foreground">{t("audit.time")}</th>
                                  <th className="text-start px-4 py-2 font-medium text-muted-foreground">{t("audit.email")}</th>
                                  <th className="text-start px-4 py-2 font-medium text-muted-foreground">{t("audit.result")}</th>
                                  <th className="text-start px-4 py-2 font-medium text-muted-foreground">{t("audit.ip")}</th>
                                </tr>
                              </thead>
                              <tbody>
                                {loginAttempts.map((attempt, i) => (
                                  <tr key={attempt.id} className={cn("border-t border-border/40", i % 2 === 0 ? "" : "bg-muted/20")}>
                                    <td className="px-4 py-2 text-muted-foreground whitespace-nowrap">{new Date(attempt.createdAt).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" })}</td>
                                    <td className="px-4 py-2 truncate max-w-[180px]">{attempt.email}</td>
                                    <td className="px-4 py-2">
                                      {attempt.success ? (
                                        <span className="inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-xs font-medium bg-green-500/15 text-green-600">
                                          <CheckCircle2 className="w-3 h-3" /> {t("audit.success")}
                                        </span>
                                      ) : (
                                        <span className="inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-xs font-medium bg-destructive/15 text-destructive">
                                          <AlertTriangle className="w-3 h-3" /> {attempt.failReason || t("audit.failed")}
                                        </span>
                                      )}
                                    </td>
                                    <td className="px-4 py-2 text-muted-foreground">{attempt.ip || "—"}</td>
                                  </tr>
                                ))}
                              </tbody>
                            </table>
                          </div>
                        )}
                      </div>
                    </div>
                  </ScrollArea>
                </TabsContent>

                <TabsContent value="storage" className="h-full mt-0 focus-visible:outline-none">
                  <div className="px-6 sm:px-8 flex flex-col h-full">
                    <div className="mb-4">
                      <p className="text-sm text-muted-foreground">{t("storage.description")}</p>
                    </div>
                    <ScrollArea className="flex-1">
                      {!storageLoaded ? (
                        <div className="flex items-center gap-2 text-muted-foreground py-8 justify-center">
                          <Loader2 className="w-4 h-4 animate-spin" />
                          <span className="text-sm">{t("storage.loading")}</span>
                        </div>
                      ) : storageStats.length === 0 ? (
                        <p className="text-sm text-muted-foreground py-8 text-center">{t("storage.noData")}</p>
                      ) : (
                        <div className="pb-8">
                          <div className="grid grid-cols-5 gap-2 mb-2 px-2 text-xs font-semibold text-muted-foreground uppercase tracking-wide">
                            <div className="col-span-2">{t("storage.user")}</div>
                            <div className="text-right">{t("storage.articles")}</div>
                            <div className="text-right">{t("storage.feeds")}</div>
                            <div className="text-right">{t("storage.aiSummaries")}</div>
                          </div>
                          <div className="space-y-2">
                            {storageStats
                              .sort((a, b) => b.articles - a.articles)
                              .map((stat) => (
                                <div
                                  key={stat.id}
                                  className="grid grid-cols-5 gap-2 items-center rounded-2xl border border-border/50 bg-card/70 px-4 py-3 text-sm"
                                >
                                  <div className="col-span-2 min-w-0">
                                    <div className="font-medium truncate">{stat.name || stat.email}</div>
                                    {stat.name && <div className="text-xs text-muted-foreground truncate">{stat.email}</div>}
                                  </div>
                                  <div className="text-right tabular-nums">{format.number(stat.articles)}</div>
                                  <div className="text-right tabular-nums">{format.number(stat.feeds)}</div>
                                  <div className="text-right tabular-nums">{format.number(stat.aiSummaries)}</div>
                                </div>
                              ))}
                          </div>
                          <div className="mt-4 rounded-2xl border border-border/40 bg-muted/30 px-4 py-3 text-xs text-muted-foreground">
                            <strong>Total:</strong>{" "}
                            {format.number(storageStats.reduce((s, r) => s + r.articles, 0))} {t("storage.articles").toLowerCase()} ·{" "}
                            {format.number(storageStats.reduce((s, r) => s + r.feeds, 0))} {t("storage.feeds").toLowerCase()} ·{" "}
                            {format.number(storageStats.reduce((s, r) => s + r.aiSummaries, 0))} {t("storage.aiSummaries").toLowerCase()}
                          </div>
                        </div>
                      )}
                    </ScrollArea>
                  </div>
                </TabsContent>

                {/* ── SYSTEM LOGS ── */}
                <TabsContent value="logs" className="h-full mt-0 focus-visible:outline-none">
                  <div className="px-6 sm:px-8 flex flex-col h-full">
                    <div className="mb-4 flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
                      <div className="flex flex-wrap gap-2">
                        {([undefined, "mail", "digest", "sync"] as const).map((cat) => (
                          <Button
                            key={cat ?? "all"}
                            size="sm"
                            variant={logsCategory === cat ? "default" : "outline"}
                            className="rounded-2xl"
                            onClick={() => {
                              setLogsCategory(cat);
                              loadSystemLogs(cat);
                            }}
                          >
                            {cat === undefined ? t("logs.all") : cat}
                          </Button>
                        ))}
                      </div>
                      <Button
                        size="sm"
                        variant="outline"
                        className="rounded-2xl gap-2"
                        onClick={() => loadSystemLogs(logsCategory)}
                      >
                        <RefreshCw className="h-3.5 w-3.5" />
                        {t("logs.refresh")}
                      </Button>
                    </div>
                    <ScrollArea className="flex-1">
                      {!logsLoaded ? (
                        <div className="flex items-center gap-2 text-muted-foreground py-8 justify-center">
                          <Loader2 className="w-4 h-4 animate-spin" />
                        </div>
                      ) : systemLogs.length === 0 ? (
                        <Empty className="border-0">
                          <EmptyMedia variant="icon"><FileText className="size-5" /></EmptyMedia>
                          <EmptyContent>
                            <EmptyTitle>{t("logs.empty")}</EmptyTitle>
                          </EmptyContent>
                        </Empty>
                      ) : (
                        <div className="pb-8">
                          <div className="rounded-2xl border border-border/60 overflow-hidden">
                            <table className="w-full text-sm">
                              <thead className="bg-muted/40">
                                <tr>
                                  <th className="text-start px-4 py-2 font-medium text-muted-foreground whitespace-nowrap">Time</th>
                                  <th className="text-start px-4 py-2 font-medium text-muted-foreground">Level</th>
                                  <th className="text-start px-4 py-2 font-medium text-muted-foreground">Category</th>
                                  <th className="text-start px-4 py-2 font-medium text-muted-foreground">Message</th>
                                </tr>
                              </thead>
                              <tbody>
                                {systemLogs.map((entry, i) => (
                                  <tr key={entry.id} className={cn("border-t border-border/40", i % 2 === 0 ? "" : "bg-muted/20")}>
                                    <td className="px-4 py-2 text-muted-foreground whitespace-nowrap text-xs">{new Date(entry.createdAt).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" })}</td>
                                    <td className="px-4 py-2">
                                      <span className={cn("inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium", {
                                        "bg-blue-500/15 text-blue-600": entry.level === "info",
                                        "bg-amber-500/15 text-amber-600": entry.level === "warn",
                                        "bg-destructive/15 text-destructive": entry.level === "error",
                                      })}>
                                        {entry.level === "info" ? t("logs.levelInfo") : entry.level === "warn" ? t("logs.levelWarn") : t("logs.levelError")}
                                      </span>
                                    </td>
                                    <td className="px-4 py-2 text-muted-foreground">{entry.category}</td>
                                    <td className="px-4 py-2 truncate max-w-[300px]">{entry.message}</td>
                                  </tr>
                                ))}
                              </tbody>
                            </table>
                          </div>
                        </div>
                      )}
                    </ScrollArea>
                  </div>
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
              <AlertDialogTitle>{t("users.deleteUserTitle")}</AlertDialogTitle>
              <AlertDialogDescription>
                {pendingDeleteUser?.email || ""} {t("users.deleteUserConfirm")}
              </AlertDialogDescription>
            </AlertDialogHeader>
            <AlertDialogFooter>
              <AlertDialogCancel className="rounded-2xl">{t("users.cancelButton")}</AlertDialogCancel>
              <AlertDialogAction
                className="rounded-2xl bg-destructive text-destructive-foreground hover:bg-destructive/90"
                onClick={() => {
                  if (!pendingDeleteUser) return;
                  handleDeleteUser(pendingDeleteUser.id);
                  setPendingDeleteUser(null);
                }}
              >
                {t("users.deleteButton")}
              </AlertDialogAction>
            </AlertDialogFooter>
          </AlertDialogContent>
        </AlertDialog>
    </>
  );
  return pageMode ? (
    <SettingsPageShell {...shellProps} backHref="/">{body}</SettingsPageShell>
  ) : (
    <SettingsModalShell {...shellProps} open={open} onOpenChange={onOpenChange}>{body}</SettingsModalShell>
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

function DiscoveryCatalogTab() {
  const t = useTranslations("serverManagement");
  const [stats, setStats] = useState<{
    totalFeeds: number;
    byCategory: { category: string; count: number }[];
  } | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [isImporting, setIsImporting] = useState(false);
  const [importResult, setImportResult] = useState<{
    totalFetched: number;
    totalAdded: number;
    totalSkipped: number;
    totalInCatalog: number;
    sources: { name: string; fetched: number; added: number; error?: string }[];
  } | null>(null);

  const loadStats = async () => {
    setIsLoading(true);
    try {
      const res = await fetch("/api/discovery/catalog/import");
      if (res.ok) {
        const data = await res.json();
        setStats(data);
      }
    } catch {
      // ignore
    } finally {
      setIsLoading(false);
    }
  };

  useEffect(() => {
    loadStats();
  }, []);

  const handleImport = async () => {
    setIsImporting(true);
    setImportResult(null);
    try {
      const res = await fetch("/api/discovery/catalog/import", { method: "POST" });
      const data = await res.json();
      if (res.ok) {
        setImportResult(data);
        toast.success(t("toast.discoveryImported", { count: data.totalAdded }));
        loadStats();
      } else {
        toast.error(data.error || t("toast.discoveryImportFailed"));
      }
    } catch (error) {
      toast.error(t("toast.discoveryImportFailed"));
    } finally {
      setIsImporting(false);
    }
  };

  const handleClear = async () => {
    if (!confirm("Clear all feeds from discovery catalog?")) return;
    try {
      const res = await fetch("/api/discovery/catalog", { method: "DELETE" });
      if (res.ok) {
        toast.success(t("toast.catalogCleared"));
        loadStats();
        setImportResult(null);
      }
    } catch {
      toast.error(t("toast.failedToClearCatalog"));
    }
  };

  return (
    <ScrollArea className="h-full">
      <div className="px-6 sm:px-8 py-6 space-y-6">
        <div>
          <h3 className="text-lg font-semibold mb-1">{t("discovery.title")}</h3>
          <p className="text-sm text-muted-foreground">
            {t("discovery.description")}
          </p>
        </div>

        {/* Stats */}
        {isLoading ? (
          <div className="flex items-center gap-2 text-muted-foreground">
            <Loader2 className="w-4 h-4 animate-spin" />
            <span className="text-sm">{t("discovery.loadingStats")}</span>
          </div>
        ) : stats ? (
          <div className="p-4 rounded-2xl bg-muted/50 border border-border/50">
            <div className="flex items-center justify-between mb-3">
              <span className="font-medium">{t("discovery.catalogStatus")}</span>
              <span className="text-2xl font-bold">{stats.totalFeeds} {t("discovery.feeds")}</span>
            </div>
            {stats.byCategory.length > 0 && (
              <div className="flex flex-wrap gap-2">
                {stats.byCategory.map((cat) => (
                  <span
                    key={cat.category}
                    className="px-2 py-1 text-xs rounded-lg bg-background border border-border/50"
                  >
                    {cat.category}: {cat.count}
                  </span>
                ))}
              </div>
            )}
          </div>
        ) : null}

        {/* Import Button */}
        <div className="flex flex-col sm:flex-row gap-3">
          <Button
            onClick={handleImport}
            disabled={isImporting}
            className="rounded-2xl"
          >
            {isImporting ? (
              <>
                <Loader2 className="w-4 h-4 me-2 animate-spin" />
                {t("discovery.importing")}
              </>
            ) : (
              <>
                <Download className="w-4 h-4 me-2" />
                {t("discovery.importFromPublic")}
              </>
            )}
          </Button>
          {stats && stats.totalFeeds > 0 && (
            <Button
              variant="outline"
              onClick={handleClear}
              className="rounded-2xl"
            >
              <Trash2 className="w-4 h-4 me-2" />
              {t("discovery.clearCatalog")}
            </Button>
          )}
        </div>

        {/* Import Result */}
        {importResult && (
          <div className="p-4 rounded-2xl bg-emerald-500/10 border border-emerald-500/20 space-y-3">
            <div className="flex items-center gap-2 text-emerald-700 dark:text-emerald-400">
              <ShieldCheck className="w-5 h-5" />
              <span className="font-medium">{t("discovery.importComplete")}</span>
            </div>
            <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 text-sm">
              <div>
                <span className="text-muted-foreground">{t("discovery.fetched")}</span>
                <p className="font-medium">{importResult.totalFetched}</p>
              </div>
              <div>
                <span className="text-muted-foreground">{t("discovery.added")}</span>
                <p className="font-medium text-emerald-600">{importResult.totalAdded}</p>
              </div>
              <div>
                <span className="text-muted-foreground">{t("discovery.skipped")}</span>
                <p className="font-medium">{importResult.totalSkipped}</p>
              </div>
              <div>
                <span className="text-muted-foreground">{t("discovery.total")}</span>
                <p className="font-medium">{importResult.totalInCatalog}</p>
              </div>
            </div>
            <div className="pt-2 border-t border-emerald-500/20">
              <p className="text-xs text-muted-foreground mb-2">{t("discovery.sources")}</p>
              <div className="space-y-1">
                {importResult.sources.map((src) => (
                  <div key={src.name} className="flex items-center justify-between text-xs">
                    <span>{src.name}</span>
                    {src.error ? (
                      <span className="text-destructive">{src.error}</span>
                    ) : (
                      <span className="text-muted-foreground">+{src.added} feeds</span>
                    )}
                  </div>
                ))}
              </div>
            </div>
          </div>
        )}

        {/* Info */}
        <div className="p-4 rounded-2xl bg-muted/30 border border-border/50 text-sm text-muted-foreground">
          <p className="mb-2">
            <strong>{t("discovery.sources")}</strong> awesome-rss-feeds, awesome-tech-rss (GitHub)
          </p>
          <p>
            {t("discovery.feedsImportedLocally")}
          </p>
        </div>
      </div>
    </ScrollArea>
  );
}

function NotificationsAdminPanel() {
  const t = useTranslations("serverManagement");
  const [diag, setDiag] = useState<{
    configured: boolean;
    publicKey: string;
    contact: string;
    privateKeyConfigured: boolean;
    activeSubscriptions: number;
    totalUsers: number;
  } | null>(null);
  const [loading, setLoading] = useState(true);
  const [generated, setGenerated] = useState<{ publicKey: string; privateKey: string } | null>(null);
  const [generating, setGenerating] = useState(false);

  useEffect(() => {
    let cancelled = false;
    getPushDiagnostics()
      .then((data) => {
        if (!cancelled) setDiag(data);
      })
      .catch((error) => {
        console.error(error);
        if (!cancelled) toast.error(t("toast.failedToLoadPushDiagnostics"));
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [t]);

  const handleGenerate = async () => {
    setGenerating(true);
    try {
      const keys = await generateVapidKeyPair();
      setGenerated(keys);
      toast.success(t("toast.vapidKeysGenerated"));
    } catch (error: any) {
      toast.error(error?.message || t("toast.failedToGenerateKeys"));
    } finally {
      setGenerating(false);
    }
  };

  const copy = async (label: string, value: string) => {
    try {
      await navigator.clipboard.writeText(value);
      toast.success(t("toast.copied", { label }));
    } catch {
      toast.error(t("toast.couldNotCopy", { label }));
    }
  };

  return (
    <div className="space-y-6">
      <div>
        <h3 className="text-xl font-semibold tracking-[-0.02em]">{t("pushNotifications.title")}</h3>
        <p className="mt-1 text-sm text-muted-foreground">
          {t("pushNotifications.description")}
        </p>
      </div>

      <div className="rounded-3xl border border-border/60 bg-card/85 p-5 sm:p-6 space-y-4">
        <div className="flex items-start gap-3">
          <div className={cn(
            "flex h-10 w-10 shrink-0 items-center justify-center rounded-2xl",
            diag?.configured ? "bg-emerald-500/10 text-emerald-500" : "bg-amber-500/10 text-amber-600",
          )}>
            {diag?.configured ? <CheckCircle2 className="w-5 h-5" /> : <AlertTriangle className="w-5 h-5" />}
          </div>
          <div className="flex-1">
            <div className="text-sm font-semibold">
              {loading ? t("pushNotifications.checking") : diag?.configured ? t("pushNotifications.configured") : t("pushNotifications.notConfigured")}
            </div>
            {!loading && diag && (
              <div className="mt-1 text-xs text-muted-foreground space-y-0.5">
                <p>{t("pushNotifications.publicKey")} <code className="rounded bg-background/60 px-1">{diag.publicKey || "—"}</code></p>
                <p>{t("pushNotifications.privateKey")} {diag.privateKeyConfigured ? t("pushNotifications.set") : t("pushNotifications.missing")}</p>
                <p>{t("pushNotifications.contact")} <code className="rounded bg-background/60 px-1">{diag.contact || "—"}</code></p>
                <p>{diag.activeSubscriptions} active subscription{diag.activeSubscriptions === 1 ? "" : "s"} across {diag.totalUsers} user{diag.totalUsers === 1 ? "" : "s"}</p>
              </div>
            )}
          </div>
        </div>
      </div>

      <div className="rounded-3xl border border-border/60 bg-card/85 p-5 sm:p-6 space-y-4">
        <div className="flex items-start gap-3">
          <KeyRound className="w-5 h-5 text-muted-foreground mt-0.5" />
          <div className="flex-1 space-y-2">
            <h4 className="text-sm font-semibold">{t("pushNotifications.setupVapid")}</h4>
            <p className="text-xs text-muted-foreground">
              Generate a key pair and add the values to your environment, then restart the server.
            </p>
            <ol className="list-decimal list-inside text-xs text-muted-foreground space-y-1 mt-2">
              <li>Click <strong className="text-foreground/80">Generate keys</strong> below.</li>
              <li>Copy the keys and your contact email into your environment file:
                <pre className="mt-1 rounded-xl bg-background/60 border border-border/50 p-2 text-[11px] font-mono whitespace-pre overflow-x-auto">{`WEB_PUSH_VAPID_PUBLIC_KEY=…
WEB_PUSH_VAPID_PRIVATE_KEY=…
WEB_PUSH_CONTACT=mailto:admin@example.com`}</pre>
              </li>
              <li>Restart the FeedFerret service.</li>
              <li>Each user opts in from Settings → Browser notifications.</li>
            </ol>
          </div>
        </div>

        <div className="flex flex-col gap-3 sm:flex-row">
          <Button type="button" className="rounded-2xl" onClick={handleGenerate} disabled={generating}>
            {generating ? <Loader2 className="w-4 h-4 animate-spin me-2" /> : <KeyRound className="w-4 h-4 me-2" />}
            {t("pushNotifications.generateKeys")}
          </Button>
        </div>

        {generated && (
          <div className="rounded-2xl border border-border/60 bg-background/60 p-4 space-y-3">
            <div>
              <Label className="text-xs uppercase tracking-wider text-muted-foreground">{t("pushNotifications.publicKeyLabel")}</Label>
              <div className="flex items-center gap-2 mt-1">
                <code className="flex-1 truncate rounded-xl bg-background border border-border/50 px-3 py-2 text-xs font-mono">
                  {generated.publicKey}
                </code>
                <Button type="button" size="icon" variant="outline" className="rounded-xl" onClick={() => copy("public key", generated.publicKey)}>
                  <ClipboardCopy className="w-4 h-4" />
                </Button>
              </div>
            </div>
            <div>
              <Label className="text-xs uppercase tracking-wider text-muted-foreground">{t("pushNotifications.privateKeyLabel")}</Label>
              <div className="flex items-center gap-2 mt-1">
                <code className="flex-1 truncate rounded-xl bg-background border border-border/50 px-3 py-2 text-xs font-mono">
                  {generated.privateKey}
                </code>
                <Button type="button" size="icon" variant="outline" className="rounded-xl" onClick={() => copy("private key", generated.privateKey)}>
                  <ClipboardCopy className="w-4 h-4" />
                </Button>
              </div>
            </div>
            <p className="text-xs text-muted-foreground">
              {t("pushNotifications.generatedKeysNote")}
            </p>
          </div>
        )}
      </div>

      <div className="rounded-3xl border border-border/60 bg-card/85 p-5 sm:p-6 space-y-2">
        <h4 className="text-sm font-semibold">{t("pushNotifications.pwaAppBadge")}</h4>
        <p className="text-xs text-muted-foreground">
          {t("pushNotifications.badgeDescription")}
        </p>
      </div>
    </div>
  );
}
