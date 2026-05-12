"use client";

import { useState } from "react";
import { Webhook, Zap, Plus, Trash2, RotateCcw, Send, ChevronDown, ChevronUp, Copy, Check, ExternalLink, AlertCircle, CheckCircle2, Clock } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import { cn } from "@/lib/utils";
import { useWebhooks, useCreateWebhook, useUpdateWebhook, useDeleteWebhook, useRotateWebhookSecret, useWebhookDeliveries, useSendTestWebhook } from "@/hooks/use-rss-data";
import { toast } from "sonner";

const ALL_EVENTS = [
  { id: "new_article", label: "New article", description: "Fires when a new article is synced" },
  { id: "keyword_match", label: "Keyword match", description: "Fires when a keyword alert matches" },
  { id: "feed_error", label: "Feed error", description: "Fires when a feed fails to sync" },
];

function CopyButton({ value }: { value: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <button
      type="button"
      onClick={() => {
        navigator.clipboard.writeText(value);
        setCopied(true);
        setTimeout(() => setCopied(false), 1500);
      }}
      className="rounded-lg p-1.5 hover:bg-muted transition-colors text-muted-foreground"
      title="Copy"
    >
      {copied ? <Check className="w-3.5 h-3.5 text-green-500" /> : <Copy className="w-3.5 h-3.5" />}
    </button>
  );
}

function DeliveryLog({ webhookId }: { webhookId: string }) {
  const { data: deliveries = [], isLoading } = useWebhookDeliveries(webhookId);

  if (isLoading) return <p className="text-sm text-muted-foreground py-2">Loading…</p>;
  if (deliveries.length === 0) return <p className="text-sm text-muted-foreground py-2">No deliveries yet.</p>;

  return (
    <div className="space-y-1.5 max-h-64 overflow-y-auto pr-1">
      {deliveries.map((d) => (
        <div key={d.id} className="flex items-start gap-3 text-xs rounded-xl bg-muted/50 px-3 py-2">
          {d.status === "success" ? (
            <CheckCircle2 className="w-3.5 h-3.5 text-green-500 mt-0.5 shrink-0" />
          ) : d.status === "failed" ? (
            <AlertCircle className="w-3.5 h-3.5 text-destructive mt-0.5 shrink-0" />
          ) : (
            <Clock className="w-3.5 h-3.5 text-amber-500 mt-0.5 shrink-0" />
          )}
          <div className="flex-1 min-w-0">
            <div className="flex items-center gap-2 flex-wrap">
              <span className="font-medium">{d.event}</span>
              {d.statusCode && <span className="text-muted-foreground">HTTP {d.statusCode}</span>}
              <span className="text-muted-foreground ml-auto">{new Date(d.createdAt).toLocaleString()}</span>
            </div>
            {d.error && <p className="text-destructive mt-0.5 truncate">{d.error}</p>}
            {d.status === "pending" && d.nextRetryAt && (
              <p className="text-amber-600 mt-0.5">
                Retry {d.attempts}/{5} · next at {new Date(d.nextRetryAt).toLocaleTimeString()}
              </p>
            )}
          </div>
        </div>
      ))}
    </div>
  );
}

interface WebhookFormData {
  name: string;
  url: string;
  events: string[];
}

function WebhookForm({
  initial,
  onSave,
  onCancel,
  newSecret,
}: {
  initial?: WebhookFormData;
  onSave: (data: WebhookFormData) => void;
  onCancel: () => void;
  newSecret?: string;
}) {
  const [name, setName] = useState(initial?.name ?? "");
  const [url, setUrl] = useState(initial?.url ?? "");
  const [events, setEvents] = useState<string[]>(initial?.events ?? ["new_article"]);

  const toggleEvent = (id: string) =>
    setEvents((prev) => (prev.includes(id) ? prev.filter((e) => e !== id) : [...prev, id]));

  return (
    <div className="space-y-4">
      <div className="space-y-2">
        <label className="text-sm font-medium">Name</label>
        <Input
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="My automation"
          className="rounded-xl h-10"
        />
      </div>
      <div className="space-y-2">
        <label className="text-sm font-medium">URL</label>
        <Input
          value={url}
          onChange={(e) => setUrl(e.target.value)}
          placeholder="https://…"
          className="rounded-xl h-10 font-mono text-sm"
        />
      </div>
      <div className="space-y-2">
        <label className="text-sm font-medium">Events</label>
        <div className="space-y-2">
          {ALL_EVENTS.map((ev) => (
            <label key={ev.id} className="flex items-start gap-3 cursor-pointer group">
              <input
                type="checkbox"
                checked={events.includes(ev.id)}
                onChange={() => toggleEvent(ev.id)}
                className="mt-0.5 rounded"
              />
              <div>
                <p className="text-sm font-medium">{ev.label}</p>
                <p className="text-xs text-muted-foreground">{ev.description}</p>
              </div>
            </label>
          ))}
        </div>
      </div>
      {newSecret && (
        <div className="rounded-xl border border-amber-500/30 bg-amber-500/5 p-3 space-y-1">
          <p className="text-xs font-medium text-amber-700 dark:text-amber-400">Secret — copy now, not shown again</p>
          <div className="flex items-center gap-2 font-mono text-xs break-all">
            <span className="flex-1">{newSecret}</span>
            <CopyButton value={newSecret} />
          </div>
        </div>
      )}
      <div className="flex gap-2 justify-end pt-1">
        <Button variant="ghost" size="sm" onClick={onCancel} className="rounded-xl">
          Cancel
        </Button>
        <Button
          size="sm"
          className="rounded-xl"
          disabled={!name.trim() || !url.trim() || events.length === 0}
          onClick={() => onSave({ name: name.trim(), url: url.trim(), events })}
        >
          Save
        </Button>
      </div>
    </div>
  );
}

function WebhookRow({ webhook }: { webhook: {
  id: string; name: string; url: string; enabled: boolean; events: string; feedFilter: string | null;
  createdAt: Date; _count: { deliveries: number };
}}) {
  const [expanded, setExpanded] = useState(false);
  const [editing, setEditing] = useState(false);
  const [showLog, setShowLog] = useState(false);
  const [newSecret, setNewSecret] = useState<string | null>(null);

  const updateWebhook = useUpdateWebhook();
  const deleteWebhook = useDeleteWebhook();
  const rotateSecret = useRotateWebhookSecret();
  const sendTest = useSendTestWebhook();

  const events: string[] = JSON.parse(webhook.events);

  const handleRotate = async () => {
    const result = await rotateSecret.mutateAsync(webhook.id);
    setNewSecret(result.secret);
    toast.success("Secret rotated");
  };

  if (editing) {
    return (
      <div className="rounded-2xl border border-border/65 bg-card/85 p-4 backdrop-blur-sm">
        <WebhookForm
          initial={{ name: webhook.name, url: webhook.url, events }}
          onSave={(data) => {
            updateWebhook.mutate({ id: webhook.id, data });
            setEditing(false);
          }}
          onCancel={() => setEditing(false)}
        />
      </div>
    );
  }

  return (
    <div className="rounded-2xl border border-border/65 bg-card/85 backdrop-blur-sm overflow-hidden">
      <div className="flex items-center gap-3 p-4">
        <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-primary/10 text-primary">
          <Zap className="w-4 h-4" />
        </div>
        <div className="flex-1 min-w-0">
          <p className="font-medium text-sm truncate">{webhook.name}</p>
          <p className="text-xs text-muted-foreground truncate font-mono">{webhook.url}</p>
        </div>
        <div className="flex items-center gap-2 shrink-0">
          <div className="hidden sm:flex gap-1">
            {events.map((e) => (
              <span key={e} className="text-[10px] px-1.5 py-0.5 rounded-full bg-muted text-muted-foreground font-medium">
                {e.replace("_", " ")}
              </span>
            ))}
          </div>
          <Switch
            checked={webhook.enabled}
            onCheckedChange={(checked) => updateWebhook.mutate({ id: webhook.id, data: { enabled: checked } })}
            className="h-6 w-10"
          />
          <button
            type="button"
            onClick={() => setExpanded((v) => !v)}
            className="rounded-lg p-1.5 hover:bg-muted transition-colors text-muted-foreground"
          >
            {expanded ? <ChevronUp className="w-4 h-4" /> : <ChevronDown className="w-4 h-4" />}
          </button>
        </div>
      </div>

      {expanded && (
        <div className="border-t border-border/50 p-4 space-y-4">
          {newSecret && (
            <div className="rounded-xl border border-amber-500/30 bg-amber-500/5 p-3 space-y-1">
              <p className="text-xs font-medium text-amber-700 dark:text-amber-400">New secret — copy now</p>
              <div className="flex items-center gap-2 font-mono text-xs break-all">
                <span className="flex-1">{newSecret}</span>
                <CopyButton value={newSecret} />
              </div>
            </div>
          )}

          <div className="flex flex-wrap gap-2">
            <Button variant="outline" size="sm" className="rounded-xl h-8 text-xs gap-1.5" onClick={() => setEditing(true)}>
              Edit
            </Button>
            <Button
              variant="outline"
              size="sm"
              className="rounded-xl h-8 text-xs gap-1.5"
              onClick={() => sendTest.mutate(webhook.id)}
              disabled={sendTest.isPending}
            >
              <Send className="w-3 h-3" />
              Test
            </Button>
            <Button
              variant="outline"
              size="sm"
              className="rounded-xl h-8 text-xs gap-1.5"
              onClick={handleRotate}
              disabled={rotateSecret.isPending}
            >
              <RotateCcw className="w-3 h-3" />
              Rotate secret
            </Button>
            <Button
              variant="outline"
              size="sm"
              className="rounded-xl h-8 text-xs gap-1.5 text-destructive hover:text-destructive"
              onClick={() => deleteWebhook.mutate(webhook.id)}
            >
              <Trash2 className="w-3 h-3" />
              Delete
            </Button>
          </div>

          <div>
            <button
              type="button"
              className="flex items-center gap-1.5 text-sm font-medium text-muted-foreground hover:text-foreground transition-colors"
              onClick={() => setShowLog((v) => !v)}
            >
              {showLog ? <ChevronUp className="w-3.5 h-3.5" /> : <ChevronDown className="w-3.5 h-3.5" />}
              Delivery log ({webhook._count.deliveries})
            </button>
            {showLog && (
              <div className="mt-2">
                <DeliveryLog webhookId={webhook.id} />
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

export function WebhookSection() {
  const { data: webhooks = [], isLoading } = useWebhooks();
  const createWebhook = useCreateWebhook();
  const [creating, setCreating] = useState(false);
  const [newSecret, setNewSecret] = useState<string | null>(null);

  const handleCreate = async (data: { name: string; url: string; events: string[] }) => {
    const result = await createWebhook.mutateAsync(data);
    setNewSecret(result.secret);
    setCreating(false);
    toast.success("Webhook created");
  };

  return (
    <section className="rounded-[2rem] border border-border/65 bg-card/85 p-5 shadow-sm backdrop-blur-2xl sm:p-6">
      <div className="flex items-start justify-between gap-4 mb-6">
        <div className="flex items-start gap-4">
          <div className="flex h-12 w-12 shrink-0 items-center justify-center rounded-2xl bg-primary/10 text-primary">
            <Webhook className="h-5 w-5" />
          </div>
          <div>
            <h2 className="text-lg font-semibold tracking-[-0.02em]">Outbound Webhooks</h2>
            <p className="mt-1 max-w-xl text-sm leading-6 text-muted-foreground">
              Send signed HTTP POST payloads to external services when articles sync, keyword alerts match, or feeds fail.
            </p>
          </div>
        </div>
        {!creating && (
          <Button
            variant="outline"
            size="sm"
            className="h-9 rounded-2xl border-border/70 bg-background/70 px-4 shrink-0 gap-1.5"
            onClick={() => { setCreating(true); setNewSecret(null); }}
          >
            <Plus className="w-4 h-4" />
            Add
          </Button>
        )}
      </div>

      <div className="space-y-3">
        {creating && (
          <div className="rounded-2xl border border-border/65 bg-muted/30 p-4">
            <h3 className="text-sm font-semibold mb-4">New webhook</h3>
            <WebhookForm
              onSave={handleCreate}
              onCancel={() => setCreating(false)}
              newSecret={newSecret ?? undefined}
            />
          </div>
        )}

        {isLoading && <p className="text-sm text-muted-foreground">Loading…</p>}

        {!isLoading && webhooks.length === 0 && !creating && (
          <div className="rounded-2xl border border-dashed border-border/60 p-8 text-center">
            <Zap className="w-8 h-8 text-muted-foreground/40 mx-auto mb-3" />
            <p className="text-sm text-muted-foreground">No webhooks yet.</p>
            <p className="text-xs text-muted-foreground/70 mt-1">
              Connect to n8n, Zapier, Make, or any HTTP endpoint.
            </p>
          </div>
        )}

        {webhooks.map((wh) => (
          <WebhookRow key={wh.id} webhook={wh as any} />
        ))}

        <div className="rounded-xl bg-muted/40 p-3 text-xs text-muted-foreground space-y-1">
          <p className="font-medium text-foreground/80">Signature verification</p>
          <p>Every request includes <code className="font-mono bg-muted px-1 rounded">X-FeedFerret-Signature: sha256=&lt;hex&gt;</code></p>
          <p>Verify: <code className="font-mono bg-muted px-1 rounded">HMAC-SHA256(secret, raw_body)</code></p>
          <a
            href="https://github.com/moby3012/feedferret/blob/main/docs/webhooks.md"
            target="_blank"
            rel="noopener noreferrer"
            className="inline-flex items-center gap-1 text-primary hover:underline"
          >
            Payload examples <ExternalLink className="w-3 h-3" />
          </a>
        </div>
      </div>
    </section>
  );
}
