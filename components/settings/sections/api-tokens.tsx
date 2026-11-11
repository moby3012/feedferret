"use client";

import { useTranslations, useFormatter } from "next-intl";
import { Copy, Key, Trash2, Plus } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { useState, useCallback, useEffect } from "react";
import { Input } from "@/components/ui/input";
import { Empty, EmptyMedia, EmptyTitle, EmptyContent } from "@/components/ui/empty";
import { toast } from "sonner";

export function ApiTokenSection() {
  const t = useTranslations();
  const format = useFormatter();
  const [tokens, setTokens] = useState<Array<{
    id: string; name: string; scope: string; expiresAt: string | null; lastUsedAt: string | null; createdAt: string;
  }>>([]);
  const [loading, setLoading] = useState(true);
  const [newRawToken, setNewRawToken] = useState<string | null>(null);
  const [newTokenId, setNewTokenId] = useState<string | null>(null);
  const [showCreate, setShowCreate] = useState(false);
  const [createName, setCreateName] = useState(t("apiTokens.defaultTokenName"));
  const [createScope, setCreateScope] = useState("write");
  const [createExpiry, setCreateExpiry] = useState("never");
  const [creating, setCreating] = useState(false);

  const loadTokens = useCallback(async () => {
    const res = await fetch("/api/user/tokens");
    if (res.ok) {
      const data = await res.json();
      setTokens(data.tokens ?? []);
    }
    setLoading(false);
  }, []);

  useEffect(() => { void loadTokens(); }, [loadTokens]);

  const handleCreate = useCallback(async () => {
    setCreating(true);
    try {
      const expiresAt = createExpiry === "never" ? null
        : new Date(Date.now() + ({ "30d": 30, "90d": 90, "1y": 365 } as Record<string, number>)[createExpiry]! * 86400_000).toISOString();
      const res = await fetch("/api/user/tokens", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: createName, scope: createScope, expiresAt }),
      });
      if (res.ok) {
        const data = await res.json();
        setNewRawToken(data.token);
        setNewTokenId(data.id);
        setShowCreate(false);
        setCreateName(t("apiTokens.defaultTokenName"));
        setCreateScope("write");
        setCreateExpiry("never");
        await loadTokens();
        toast.success(t("apiTokens.toasts.created"));
      } else {
        toast.error(t("apiTokens.toasts.failedCreate"));
      }
    } finally {
      setCreating(false);
    }
  }, [createName, createScope, createExpiry, loadTokens, t]);

  const handleRevoke = useCallback(async (id: string, name: string) => {
    const res = await fetch(`/api/user/tokens/${id}`, { method: "DELETE" });
    if (res.ok) {
      if (newTokenId === id) { setNewRawToken(null); setNewTokenId(null); }
      await loadTokens();
      toast.success(t("apiTokens.toasts.revoked", { name }));
    }
  }, [loadTokens, newTokenId, t]);

  const handleCopy = useCallback(() => {
    if (newRawToken) {
      navigator.clipboard.writeText(newRawToken);
      toast.success(t("apiTokens.toasts.copied"));
    }
  }, [newRawToken, t]);

  const scopeLabel = (scope: string) => ({ read: t("apiTokens.scopes.read"), write: t("apiTokens.scopes.readWrite"), admin: t("apiTokens.scopes.admin") } as Record<string, string>)[scope] ?? scope;
  const scopeColor = (scope: string): "secondary" | "default" | "destructive" =>
    scope === "read" ? "secondary" : scope === "admin" ? "destructive" : "default";

  return (
    <section className="rounded-panel border border-border/65 bg-card/85 p-5 sm:p-6">
      <div className="flex items-start gap-4 mb-5">
        <div className="ui-brand-icon flex h-12 w-12 shrink-0 items-center justify-center rounded-panel">
          <Key className="h-5 w-5" />
        </div>
        <div className="flex-1">
          <h2 className="text-title-sm font-semibold tracking-title">{t("apiTokens.title")}</h2>
          <p className="mt-1 text-body-sm leading-6 text-muted-foreground">
            {t("apiTokens.description")}
          </p>
        </div>
        <Button
          size="sm"
          onClick={() => setShowCreate(true)}
          className="rounded-panel h-9 shrink-0"
          aria-expanded={showCreate}
        >
          <Plus className="w-4 h-4 me-1" />
          {t("apiTokens.addToken")}
        </Button>
      </div>

      {newRawToken && (
        <div className="mb-4 rounded-panel bg-accent/5 border border-accent/20 p-4">
          <p className="text-footnote font-semibold text-foreground mb-2 uppercase tracking-wider">
            {t("apiTokens.newTokenWarning")}
          </p>
          <div className="flex items-center gap-2">
            <Input readOnly value={newRawToken} className="font-mono text-footnote h-9 bg-background/60" />
            <Button size="sm" variant="outline" onClick={handleCopy} className="shrink-0 h-9 rounded-panel">
              <Copy className="w-4 h-4" />
            </Button>
          </div>
        </div>
      )}

      {showCreate && (
        <div className="ui-control-surface mb-4 rounded-panel border p-4 space-y-3">
          <p className="text-body-sm font-medium">{t("apiTokens.createNewToken")}</p>
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
            <div className="sm:col-span-1">
              <label htmlFor="token-name" className="text-body-sm font-medium mb-1 block">{t("apiTokens.name")}</label>
              <Input id="token-name" value={createName} onChange={(e) => setCreateName(e.target.value)} className="h-9 rounded-panel" maxLength={80} />
            </div>
            <div>
              <label htmlFor="token-scope" className="text-body-sm font-medium mb-1 block">{t("apiTokens.scope")}</label>
              <Select value={createScope} onValueChange={setCreateScope}>
                <SelectTrigger id="token-scope" className="h-9 rounded-panel"><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="read">{t("apiTokens.scopes.read")}</SelectItem>
                  <SelectItem value="write">{t("apiTokens.scopes.readWrite")}</SelectItem>
                  <SelectItem value="admin">{t("apiTokens.scopes.admin")}</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div>
              <label htmlFor="token-expiry" className="text-body-sm font-medium mb-1 block">{t("apiTokens.expires")}</label>
              <Select value={createExpiry} onValueChange={setCreateExpiry}>
                <SelectTrigger id="token-expiry" className="h-9 rounded-panel"><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="never">{t("apiTokens.expiry.never")}</SelectItem>
                  <SelectItem value="30d">{t("apiTokens.expiry.d30")}</SelectItem>
                  <SelectItem value="90d">{t("apiTokens.expiry.d90")}</SelectItem>
                  <SelectItem value="1y">{t("apiTokens.expiry.y1")}</SelectItem>
                </SelectContent>
              </Select>
            </div>
          </div>
          <div className="flex gap-2 pt-1">
            <Button size="sm" onClick={handleCreate} disabled={creating || !createName.trim()} className="rounded-panel h-9">
              {creating ? t("apiTokens.creating") : t("apiTokens.create")}
            </Button>
            <Button size="sm" variant="ghost" onClick={() => setShowCreate(false)} className="rounded-panel h-9">{t("apiTokens.cancel")}</Button>
          </div>
        </div>
      )}

      {loading ? (
        <p className="text-body-sm text-muted-foreground">{t("apiTokens.loading")}</p>
      ) : tokens.length === 0 ? (
        <Empty className="border-0 py-8">
          <EmptyMedia variant="icon"><Key className="size-5" /></EmptyMedia>
          <EmptyContent>
            <EmptyTitle>{t("apiTokens.noTokens")}</EmptyTitle>
          </EmptyContent>
        </Empty>
      ) : (
        <div className="space-y-2">
          {tokens.map((tok) => (
            <div key={tok.id} className="flex items-center gap-3 rounded-panel border border-border/40 bg-background/40 px-3 py-2">
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-2 flex-wrap">
                  <span className="text-body-sm font-medium truncate">{tok.name}</span>
                  <Badge variant={scopeColor(tok.scope)} className="text-caption h-4 px-1.5">{scopeLabel(tok.scope)}</Badge>
                  {tok.expiresAt && <span className="text-caption text-muted-foreground">{t("apiTokens.expires")} {format.dateTime(new Date(tok.expiresAt), { dateStyle: "medium" })}</span>}
                </div>
                <p className="text-caption text-muted-foreground mt-0.5">
                  {t("apiTokens.created")} {format.dateTime(new Date(tok.createdAt), { dateStyle: "medium" })}
                  {tok.lastUsedAt ? ` · ${t("apiTokens.lastUsed")} ${format.dateTime(new Date(tok.lastUsedAt), { dateStyle: "medium" })}` : ` · ${t("apiTokens.neverUsed")}`}
                </p>
              </div>
              <Button
                size="sm"
                variant="ghost"
                className="h-7 w-7 p-0 rounded-row text-muted-foreground hover:text-destructive hover:bg-destructive/10"
                onClick={() => handleRevoke(tok.id, tok.name)}
              >
                <Trash2 className="w-4 h-4" />
              </Button>
            </div>
          ))}
        </div>
      )}

      <p className="mt-4 text-footnote text-muted-foreground">{t("apiPassword.emailChangeWarning")}</p>
      <p className="mt-4 text-footnote text-muted-foreground">
        Pass the token as <code className="bg-muted px-1 py-0.5 rounded-chip text-caption">Authorization: Bearer &lt;token&gt;</code>.{" "}
        The Fever API uses <code className="bg-muted px-1 py-0.5 rounded-chip text-caption">md5(email:token)</code> as its api_key.
      </p>
    </section>
  );
}
