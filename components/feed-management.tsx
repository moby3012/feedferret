"use client";

import { useEffect, useState, useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import { useSearchParams } from "next/navigation";
import { useTranslations, useFormatter } from "next-intl";
import {
  useFeeds,
  useDeleteFeed,
  useUpdateFeed,
  useCategories,
  useAddCategory,
  useUpdateCategory,
  useDeleteCategory,
  useUpdateCategoryOrder,
  useImportOpml,
  useExportOpml,
  useLabels,
  useMigrateKeywordAlertsToRules,
  useCreateLabel,
  useDeleteLabel,
  useSavedSearches,
  useDeleteSavedSearch,
  useSetSavedSearchSharing,
  useFeedHealth,
  useApplyRetentionPolicies,
  useAutoReadRules,
  useCreateAutoReadRule,
  useUpdateAutoReadRule,
  useDeleteAutoReadRule,
  useApplyAutoReadRulesNow,
  usePreviewAutoReadRule,
  useKeywordAlerts,
  useCreateKeywordAlert,
  useUpdateKeywordAlert,
  useDeleteKeywordAlert,
  usePreviewKeywordAlert,
  useTestKeywordAlert,
  useMarkNotificationRead,
  useAlertHistory,
  useExportUserData,
  useNotificationChannelStatus,
  useReadingPreferences,
  useUpdateGlobalSettings,
} from "@/hooks/use-rss-data";
import { Button } from "@/components/ui/button";
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
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Checkbox } from "@/components/ui/checkbox";
import { TabsContent } from "@/components/ui/tabs";
import { SettingsModalShell, SettingsPageShell } from "@/components/settings-shell";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Empty, EmptyMedia, EmptyTitle, EmptyDescription, EmptyContent } from "@/components/ui/empty";
import {
  Trash2,
  Download,
  Upload,
  FolderPlus,
  Edit2,
  Check,
  X,
  Folder,
  Tag,
  Bookmark,
  Activity,
  ShieldCheck,
  Plus,
  Play,
  Power,
  Eye,
  Settings2,
  Share2,
  Copy,
  ExternalLink,
  Rss,
  Link as LinkIcon,
  Bell,
  History,
  Pencil,
  ChevronRight,
  Info,
  Compass,
  ArrowUp,
  BellOff,
} from "lucide-react";
import { FeedEditDialog } from "@/components/feed-edit-dialog";
import { toast } from "sonner";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  DndContext,
  closestCorners,
  KeyboardSensor,
  PointerSensor,
  useSensor,
  useSensors,
  DragEndEvent,
} from "@dnd-kit/core";
import {
  arrayMove,
  SortableContext,
  sortableKeyboardCoordinates,
  verticalListSortingStrategy,
  useSortable,
} from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { restrictToVerticalAxis } from "@dnd-kit/modifiers";
import { cn } from "@/lib/utils";

type ActionCatalogItem = { value: string; label: string; group: "article" | "labels" | "notify" | "webhook"; };

type NotificationChannels = { push: boolean; email: boolean; telegram: boolean; gotify: boolean; ntfy: boolean };

const DEFAULT_CHANNELS: NotificationChannels = { push: false, email: false, telegram: false, gotify: false, ntfy: false };

// Sentinel value used by the picker — actual rule actions become
// "webhook_call:<n>" once the user fills in a URL.
const ADD_WEBHOOK_TOKEN = "__add_webhook__";

// Sentinel values for the label pickers — never stored; resolved to label:${id} / remove_label:${id}
const PICK_LABEL_TOKEN = "__pick_label__";
const REMOVE_LABEL_TOKEN = "__remove_label__";
const CREATE_LABEL_TOKEN = "__create_label__";

function catalogForTrigger(catalog: ActionCatalogItem[], trigger: "article" | "feed_error"): ActionCatalogItem[] {
  if (trigger !== "feed_error") return catalog;
  return catalog.filter((item) => item.group === "notify" || item.group === "webhook");
}

function buildActionCatalog(labels: any[], t: (key: string) => string, channels: NotificationChannels = DEFAULT_CHANNELS): ActionCatalogItem[] {
  const catalog: ActionCatalogItem[] = [
    { value: "mark_read", label: t("actions.markAsRead"), group: "article" },
    { value: "mark_unread", label: t("actions.markAsUnread"), group: "article" },
    { value: "star", label: t("actions.starArticle"), group: "article" },
    { value: "unstar", label: t("actions.unstarArticle"), group: "article" },
    { value: "read_later", label: t("actions.saveToReadLater"), group: "article" },
    { value: "remove_read_later", label: t("actions.removeFromReadLater"), group: "article" },
    { value: "delete", label: t("actions.deleteArticle"), group: "article" },
    { value: "mark_spoiler", label: t("actions.markAsSpoiler"), group: "article" },
    { value: "remove_spoiler", label: t("actions.removeSpoilerFlag"), group: "article" },
    { value: "clear_labels", label: t("actions.removeAllLabels"), group: "labels" },
    { value: PICK_LABEL_TOKEN, label: t("actions.attachLabel") + "…", group: "labels" },
    { value: REMOVE_LABEL_TOKEN, label: t("actions.removeLabel") + "…", group: "labels" },
    { value: "notify_inapp", label: t("actions.inAppNotification"), group: "notify" },
  ];
  if (channels.push) catalog.push({ value: "notify_push", label: t("actions.pushNotification"), group: "notify" });
  if (channels.email) catalog.push({ value: "notify_email", label: t("actions.emailNotification"), group: "notify" });
  if (channels.telegram) catalog.push({ value: "notify_telegram", label: t("actions.telegramMessage"), group: "notify" });
  if (channels.gotify) catalog.push({ value: "notify_gotify", label: t("actions.gotifyNotification"), group: "notify" });
  if (channels.ntfy) catalog.push({ value: "notify_ntfy", label: t("actions.ntfyNotification"), group: "notify" });
  catalog.push({ value: ADD_WEBHOOK_TOKEN, label: t("webhooks.triggerWebhook") + "…", group: "webhook" });
  return catalog;
}

function actionLabel(value: string, catalog: ActionCatalogItem[], labels: any[] | undefined, t: (key: string) => string): string {
  const hit = catalog.find((item) => item.value === value);
  if (hit) return hit.label;
  if (value.startsWith("label:")) {
    const id = value.slice("label:".length);
    const lbl = labels?.find((l: any) => l.id === id);
    return lbl ? `${t("actions.attachLabel")} · ${lbl.name}` : t("actions.labelDeleted");
  }
  if (value.startsWith("remove_label:")) {
    const id = value.slice("remove_label:".length);
    const lbl = labels?.find((l: any) => l.id === id);
    return lbl ? `${t("actions.removeLabel")} · ${lbl.name}` : t("actions.removeLabelDeleted");
  }
  if (value.startsWith("webhook_call:")) return "webhook";
  return value;
}

export type WebhookConfigUi = {
  url: string;
  method: "POST" | "GET" | "PUT" | "PATCH" | "DELETE";
  headers?: Record<string, string>;
  bodyTemplate?: string;
  secret?: string;
};

/**
 * Repack the actions list so every `webhook_call:<idx>` references a
 * contiguous index into webhookConfigs starting at 0. Returns the rewritten
 * actions and the matching configs in the same order they're referenced.
 */
function repackWebhooks(
  actions: string[],
  configs: WebhookConfigUi[],
): { actions: string[]; webhookConfigs: WebhookConfigUi[] } {
  const seenIndexToNew = new Map<number, number>();
  const nextConfigs: WebhookConfigUi[] = [];
  const nextActions = actions.map((a) => {
    if (!a.startsWith("webhook_call:")) return a;
    const oldIdx = Number.parseInt(a.slice("webhook_call:".length), 10);
    if (!Number.isFinite(oldIdx)) return a;
    if (!seenIndexToNew.has(oldIdx)) {
      const cfg = configs[oldIdx];
      if (!cfg) return a;
      const newIdx = nextConfigs.length;
      nextConfigs.push(cfg);
      seenIndexToNew.set(oldIdx, newIdx);
    }
    return `webhook_call:${seenIndexToNew.get(oldIdx)}`;
  });
  return { actions: nextActions, webhookConfigs: nextConfigs };
}

function ActionListEditor({
  value,
  webhookConfigs,
  onChange,
  catalog,
  labels,
}: {
  value: string[];
  webhookConfigs: WebhookConfigUi[];
  onChange: (next: { actions: string[]; webhookConfigs: WebhookConfigUi[] }) => void;
  catalog: ActionCatalogItem[];
  labels?: any[];
}) {
  const t = useTranslations("feedManagement");
  const [pendingLabelToken, setPendingLabelToken] = useState<typeof PICK_LABEL_TOKEN | typeof REMOVE_LABEL_TOKEN | null>(null);
  const [creatingLabel, setCreatingLabel] = useState(false);
  const [newLabelNameInput, setNewLabelNameInput] = useState("");
  const createLabelMutation = useCreateLabel();

  const reorderable = (mover: (arr: string[]) => string[]) => {
    const next = mover(value);
    onChange(repackWebhooks(next, webhookConfigs));
  };

  const removeAt = (idx: number) => {
    const next = value.filter((_, i) => i !== idx);
    onChange(repackWebhooks(next, webhookConfigs));
  };

  const addAction = (val: string) => {
    if (!val) return;
    if (val === ADD_WEBHOOK_TOKEN) {
      const newIdx = webhookConfigs.length;
      onChange({
        actions: [...value, `webhook_call:${newIdx}`],
        webhookConfigs: [
          ...webhookConfigs,
          { url: "", method: "POST" },
        ],
      });
      return;
    }
    if (val === PICK_LABEL_TOKEN || val === REMOVE_LABEL_TOKEN) {
      setPendingLabelToken(val);
      return;
    }
    onChange({
      actions: [...value, val],
      webhookConfigs,
    });
  };

  const resolveLabelPick = (labelId: string) => {
    if (!pendingLabelToken || !labelId) return;
    const action = pendingLabelToken === PICK_LABEL_TOKEN ? `label:${labelId}` : `remove_label:${labelId}`;
    setPendingLabelToken(null);
    onChange({ actions: [...value, action], webhookConfigs });
  };

  const updateWebhookConfig = (actionIdx: number, patch: Partial<WebhookConfigUi>) => {
    const action = value[actionIdx];
    if (!action.startsWith("webhook_call:")) return;
    const configIdx = Number.parseInt(action.slice("webhook_call:".length), 10);
    if (!Number.isFinite(configIdx)) return;
    const nextConfigs = webhookConfigs.map((cfg, i) =>
      i === configIdx ? { ...cfg, ...patch } : cfg,
    );
    onChange({ actions: value, webhookConfigs: nextConfigs });
  };

  const available = catalog.filter(
    (item) =>
      item.value === ADD_WEBHOOK_TOKEN ||
      item.value === PICK_LABEL_TOKEN ||
      item.value === REMOVE_LABEL_TOKEN ||
      !value.includes(item.value),
  );

  return (
    <div className="space-y-2">
      {value.length === 0 && (
        <p className="text-xs text-muted-foreground italic">{t("rules.addFirstAction")}</p>
      )}
      {value.map((action, idx) => {
        const isWebhook = action.startsWith("webhook_call:");
        const configIdx = isWebhook ? Number.parseInt(action.slice("webhook_call:".length), 10) : -1;
        const config = isWebhook && Number.isFinite(configIdx) ? webhookConfigs[configIdx] : undefined;

        return (
          <div
            key={`${action}-${idx}`}
            className="ui-control-surface rounded-xl border px-3 py-2 space-y-2"
          >
            <div className="flex items-center gap-2">
              <span className="text-xs text-muted-foreground tabular-nums shrink-0">{idx + 1}.</span>
              <span className="flex-1 truncate text-sm font-medium">
                {isWebhook ? t("webhooks.triggerWebhook") : actionLabel(action, catalog, labels, t)}
              </span>
              <button
                type="button"
                disabled={idx === 0}
                onClick={() => reorderable((arr) => {
                  const next = [...arr];
                  [next[idx - 1], next[idx]] = [next[idx], next[idx - 1]];
                  return next;
                })}
                className="rounded-lg p-1 text-muted-foreground hover:text-foreground disabled:opacity-30"
                aria-label={t("rules.moveUp")}
              >▲</button>
              <button
                type="button"
                disabled={idx === value.length - 1}
                onClick={() => reorderable((arr) => {
                  const next = [...arr];
                  [next[idx], next[idx + 1]] = [next[idx + 1], next[idx]];
                  return next;
                })}
                className="rounded-lg p-1 text-muted-foreground hover:text-foreground disabled:opacity-30"
                aria-label={t("rules.moveDown")}
              >▼</button>
              <button
                type="button"
                onClick={() => removeAt(idx)}
                className="rounded-lg p-1 text-destructive/70 hover:text-destructive"
                aria-label={t("rules.removeAction")}
              >×</button>
            </div>

            {isWebhook && config && (
              <WebhookActionConfig
                value={config}
                onChange={(patch) => updateWebhookConfig(idx, patch)}
              />
            )}
          </div>
        );
      })}
      {pendingLabelToken && !creatingLabel && (
        <Select value="" onValueChange={(val) => {
          if (val === CREATE_LABEL_TOKEN) {
            setCreatingLabel(true);
          } else {
            resolveLabelPick(val);
          }
        }}>
          <SelectTrigger className="rounded-xl h-10 border-primary/50">
            <SelectValue placeholder={
              pendingLabelToken === PICK_LABEL_TOKEN
                ? t("actions.attachLabel") + " — pick a label"
                : t("actions.removeLabel") + " — pick a label"
            } />
          </SelectTrigger>
          <SelectContent>
            {pendingLabelToken === PICK_LABEL_TOKEN && (
              <SelectItem value={CREATE_LABEL_TOKEN} className="text-link font-medium">
                {t("actions.createNewLabel")}
              </SelectItem>
            )}
            {(labels ?? []).map((lbl: any) => (
              <SelectItem key={lbl.id} value={lbl.id}>{lbl.name}</SelectItem>
            ))}
          </SelectContent>
        </Select>
      )}
      {pendingLabelToken === PICK_LABEL_TOKEN && creatingLabel && (
        <div className="flex gap-2">
          <Input
            placeholder={t("labels.newLabelPlaceholder")}
            value={newLabelNameInput}
            onChange={(e) => setNewLabelNameInput(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && newLabelNameInput.trim()) {
                e.preventDefault();
                createLabelMutation.mutateAsync({ name: newLabelNameInput.trim() }).then((lbl) => {
                  resolveLabelPick(lbl.id);
                  setCreatingLabel(false);
                  setNewLabelNameInput("");
                }).catch(() => {});
              }
              if (e.key === "Escape") {
                setCreatingLabel(false);
                setNewLabelNameInput("");
                setPendingLabelToken(null);
              }
            }}
            className="rounded-xl h-10 flex-1"
            autoFocus
          />
          <Button
            type="button"
            size="sm"
            variant="default"
            className="rounded-xl shrink-0"
            disabled={!newLabelNameInput.trim() || createLabelMutation.isPending}
            onClick={() => {
              createLabelMutation.mutateAsync({ name: newLabelNameInput.trim() }).then((lbl) => {
                resolveLabelPick(lbl.id);
                setCreatingLabel(false);
                setNewLabelNameInput("");
              }).catch(() => {});
            }}
          >
            {t("labels.addLabel")}
          </Button>
          <Button
            type="button"
            size="sm"
            variant="ghost"
            className="rounded-xl shrink-0"
            onClick={() => {
              setCreatingLabel(false);
              setNewLabelNameInput("");
              setPendingLabelToken(null);
            }}
          >
            ×
          </Button>
        </div>
      )}
      {!pendingLabelToken && available.length > 0 && (
        <Select value="" onValueChange={addAction}>
          <SelectTrigger className="rounded-xl h-10">
            <SelectValue placeholder={value.length === 0 ? t("rules.addFirstActionPlaceholder") : t("rules.addAnotherAction")} />
          </SelectTrigger>
          <SelectContent>
            {available.map((item) => (
              <SelectItem key={item.value} value={item.value}>{item.label}</SelectItem>
            ))}
          </SelectContent>
        </Select>
      )}
    </div>
  );
}

// Descriptions are looked up via t("webhooks.*") at render time
const WEBHOOK_VARIABLE_TOKENS: string[] = [
  "{{event}}",
  "{{rule_name}}",
  "{{timestamp}}",
  "{{article_title}}",
  "{{article_link}}",
  "{{article_excerpt}}",
  "{{feed_name}}",
  "{{feed_url}}",
  "{{error}}",
];
const WEBHOOK_VARIABLE_DESC_KEYS = [
  "event",
  "ruleName",
  "timestamp",
  "articleTitle",
  "articleLink",
  "articleExcerpt",
  "feedName",
  "feedUrl",
  "error",
] as const;

function WebhookActionConfig({
  value,
  onChange,
}: {
  value: WebhookConfigUi;
  onChange: (patch: Partial<WebhookConfigUi>) => void;
}) {
  const t = useTranslations("feedManagement");
  const [showAdvanced, setShowAdvanced] = useState(false);

  return (
    <div className="space-y-2 pt-1 border-t border-border/50">
      <div className="grid gap-2 sm:grid-cols-[100px_1fr]">
        <Select
          value={value.method}
          onValueChange={(method) => onChange({ method: method as WebhookConfigUi["method"] })}
        >
          <SelectTrigger className="rounded-xl h-9 text-xs font-mono">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="POST">POST</SelectItem>
            <SelectItem value="PUT">PUT</SelectItem>
            <SelectItem value="PATCH">PATCH</SelectItem>
            <SelectItem value="GET">GET</SelectItem>
            <SelectItem value="DELETE">DELETE</SelectItem>
          </SelectContent>
        </Select>
        <Input
          type="url"
          placeholder="https://example.com/hook/{{feed_name}}"
          value={value.url}
          onChange={(e) => onChange({ url: e.target.value })}
          className="rounded-xl h-9 text-xs font-mono"
        />
      </div>

      <button
        type="button"
        className="text-xs text-muted-foreground hover:text-foreground"
        onClick={() => setShowAdvanced((v) => !v)}
      >
        {showAdvanced ? t("webhooks.hideAdvanced") : t("webhooks.advanced")}
      </button>

      {showAdvanced && (
        <div className="space-y-2 pt-1">
          <div className="space-y-1">
            <label htmlFor="webhook-body-template" className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">{t("webhooks.bodyTemplate")}</label>
            <textarea
              id="webhook-body-template"
              rows={4}
              placeholder={`{\n  "title": "{{article_title}}",\n  "link": "{{article_link}}"\n}`}
              value={value.bodyTemplate ?? ""}
              onChange={(e) => onChange({ bodyTemplate: e.target.value })}
              className="w-full rounded-xl border border-border/60 bg-background px-3 py-2 text-xs font-mono"
              disabled={value.method === "GET"}
            />
            <p className="text-xs text-muted-foreground">
              {t("webhooks.defaultJsonPayload")}
            </p>
          </div>

          <div className="space-y-1">
            <label htmlFor="webhook-hmac-secret" className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
              {t("webhooks.hmacSecret")}
            </label>
            <Input
              id="webhook-hmac-secret"
              type="password"
              placeholder={t("webhooks.secretUsage")}
              value={value.secret ?? ""}
              onChange={(e) => onChange({ secret: e.target.value })}
              className="rounded-xl h-9 text-xs"
            />
          </div>

          <div className="ui-control-surface rounded-xl border p-2 text-xs leading-relaxed">
            <p className="font-medium mb-1 uppercase tracking-wider text-muted-foreground">{t("webhooks.variables")}</p>
            <ul className="grid grid-cols-1 sm:grid-cols-2 gap-x-3 gap-y-0.5">
              {WEBHOOK_VARIABLE_TOKENS.map((token, idx) => (
                <li key={token}>
                  <code className="bg-background/80 rounded px-1 font-mono">{token}</code>{" "}
                  <span className="text-muted-foreground">— {t(`webhooks.${WEBHOOK_VARIABLE_DESC_KEYS[idx]}`)}</span>
                </li>
              ))}
            </ul>
          </div>
        </div>
      )}
    </div>
  );
}

function SortableCategoryItem({
  cat,
  editingCategoryId,
  editingCategoryName,
  setEditingCategoryName,
  setEditingCategoryId,
  updateCategory,
  requestDelete,
}: any) {
  const t = useTranslations("feedManagement");
  const {
    attributes,
    listeners,
    setNodeRef,
    transform,
    transition,
    isDragging,
  } = useSortable({
    id: cat.id,
    data: { type: "category" },
  });

  const [settingsOpen, setSettingsOpen] = useState(false);
  const [syncValue, setSyncValue] = useState<string>(cat.updateFrequency ? String(cat.updateFrequency) : "");

  const style = {
    transform: CSS.Translate.toString(transform),
    transition,
    zIndex: isDragging ? 50 : undefined,
    opacity: isDragging ? 0.5 : 1,
  };

  return (
    <>
    <div
      ref={setNodeRef}
      style={style}
      className="rounded-2xl border border-border/60 bg-card p-4 shadow-sm transition-all hover:border-border"
    >
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center">
        <div
          {...attributes}
          {...listeners}
          className="cursor-grab active:cursor-grabbing"
        >
          <Folder className="w-5 h-5 text-primary" />
        </div>
        {editingCategoryId === cat.id ? (
          <div className="flex-1 flex flex-col gap-2 sm:flex-row">
            <Input
              autoFocus
              value={editingCategoryName}
              onChange={(e) => setEditingCategoryName(e.target.value)}
              className="h-9 rounded-2xl border-border/70 bg-background/70"
            />
            <Button
              size="icon"
              variant="ghost"
              className="h-9 w-9 rounded-xl text-green-500 hover:bg-green-500/10"
              onClick={() => {
                updateCategory.mutate({
                  categoryId: cat.id,
                  data: { name: editingCategoryName },
                });
                setEditingCategoryId(null);
              }}
            >
              <Check className="w-4 h-4" />
            </Button>
            <Button
              size="icon"
              variant="ghost"
              className="h-9 w-9 rounded-xl text-muted-foreground"
              onClick={() => setEditingCategoryId(null)}
            >
              <X className="w-4 h-4" />
            </Button>
          </div>
        ) : (
          <>
            <div className="min-w-0 flex-1">
              <span className="block font-semibold tracking-[-0.01em]">{cat.name}</span>
              <span className="text-xs font-semibold text-muted-foreground uppercase tracking-wider">
                {t("health.sync")} {cat.updateFrequency ? `${cat.updateFrequency} min` : t("health.default")}
              </span>
            </div>
            {/* Always-visible action buttons (#17) */}
            <div className="flex flex-wrap items-center justify-end gap-1">
              <Button
                size="icon"
                variant="ghost"
                className="h-9 w-9 rounded-xl text-muted-foreground hover:text-foreground"
                title={t("categories.categorySettingsTitle")}
                onClick={() => { setSyncValue(cat.updateFrequency ? String(cat.updateFrequency) : ""); setSettingsOpen(true); }}
              >
                <Settings2 className="size-4" />
              </Button>
              <Button
                size="icon"
                variant="ghost"
                className="h-9 w-9 rounded-xl"
                onClick={() => {
                  setEditingCategoryId(cat.id);
                  setEditingCategoryName(cat.name);
                }}
              >
                <Edit2 className="w-4 h-4" />
              </Button>
              <Button
                size="icon"
                variant="ghost"
                className="h-9 w-9 rounded-xl text-muted-foreground hover:text-destructive"
                onClick={() =>
                  requestDelete({
                    type: "category",
                    id: cat.id,
                    name: cat.name,
                  })
                }
              >
                <Trash2 className="w-4 h-4" />
              </Button>
            </div>
          </>
        )}
      </div>
    </div>
    {/* Category settings dialog (#17) */}
    <Dialog open={settingsOpen} onOpenChange={setSettingsOpen}>
      <DialogContent className="max-w-sm rounded-[2rem] border border-border/70 bg-background p-6 shadow-2xl">
        <DialogHeader>
          <div className="flex items-center gap-3">
            <Folder className="size-5 text-primary" />
            <DialogTitle className="font-semibold tracking-[-0.02em]">{t("categories.categorySettingsTitle")} — {cat.name}</DialogTitle>
          </div>
        </DialogHeader>
        <div className="space-y-1.5">
          <label htmlFor="cat-settings-sync-input" className="text-sm font-medium">{t("categories.syncIntervalLabel")}</label>
          <p className="text-xs text-muted-foreground">{t("categories.leaveEmptyForGlobal")}</p>
          <Input
            id="cat-settings-sync-input"
            type="number"
            placeholder={t("categories.example")}
            value={syncValue}
            onChange={(e) => setSyncValue(e.target.value)}
            className="h-10 rounded-2xl border-border/70 bg-background/70"
          />
        </div>
        <DialogFooter className="pt-2">
          <Button variant="ghost" className="rounded-2xl" onClick={() => setSettingsOpen(false)}>{t("categories.cancelButton")}</Button>
          <Button className="rounded-2xl" onClick={() => {
            const val = parseInt(syncValue);
            updateCategory.mutate({ categoryId: cat.id, data: { updateFrequency: isNaN(val) ? null : val } });
            setSettingsOpen(false);
          }}>{t("categories.saveButton")}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
    </>
  );
}

type FeedManagementTab =
  | "feeds"
  | "categories"
  | "labels"
  | "saved-searches"
  | "health"
  | "rules"
  | "alerts";

function normalizeInitialTab(tab?: FeedManagementTab) {
  return tab === "saved-searches" ? "labels" : tab ?? "feeds";
}

export function FeedManagement({
  open,
  onOpenChange,
  initialTab,
  pageMode = false,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  initialTab?: FeedManagementTab;
  pageMode?: boolean;
}) {
  const t = useTranslations("feedManagement");
  const tc = useTranslations("common");
  const format = useFormatter();
  const { data: feeds = [] } = useFeeds();
  const deleteFeed = useDeleteFeed();
  const updateFeed = useUpdateFeed();
  const addCategory = useAddCategory();
  const updateCategory = useUpdateCategory();
  const deleteCategory = useDeleteCategory();
  const updateCategoryOrder = useUpdateCategoryOrder();
  const importOpml = useImportOpml();
  const exportOpml = useExportOpml();
  const exportUserData = useExportUserData();
  const createLabel = useCreateLabel();
  const deleteLabel = useDeleteLabel();
  const deleteSavedSearch = useDeleteSavedSearch();
  const setSavedSearchSharing = useSetSavedSearchSharing();
  const applyRetention = useApplyRetentionPolicies();
  const { data: feedHealth = [] } = useFeedHealth();
  const { data: readingPreferences } = useReadingPreferences();
  const updateGlobalSettings = useUpdateGlobalSettings();
  const [autoMuteThreshold, setAutoMuteThreshold] = useState<string>("10");
  const { data: autoReadRules = [] } = useAutoReadRules();
  const createAutoReadRule = useCreateAutoReadRule();
  const updateAutoReadRule = useUpdateAutoReadRule();
  const deleteAutoReadRule = useDeleteAutoReadRule();
  const applyAutoReadRulesNow = useApplyAutoReadRulesNow();
  const previewAutoReadRule = usePreviewAutoReadRule();
  const { data: keywordAlerts = [] } = useKeywordAlerts();
  const migrateAlertsToRules = useMigrateKeywordAlertsToRules();
  const createKeywordAlert = useCreateKeywordAlert();
  const updateKeywordAlert = useUpdateKeywordAlert();
  const deleteKeywordAlert = useDeleteKeywordAlert();
  const previewKeywordAlert = usePreviewKeywordAlert();
  const testKeywordAlert = useTestKeywordAlert();
  const markNotificationRead = useMarkNotificationRead();

  const [activeTab, setActiveTab] = useState<string>(normalizeInitialTab(initialTab));
  const [newCategoryName, setNewCategoryName] = useState("");
  const [newLabelName, setNewLabelName] = useState("");
  const [newLabelColor, setNewLabelColor] = useState("#3b82f6");
  const [lastImportReport, setLastImportReport] = useState<any | null>(null);
  const [editingCategoryId, setEditingCategoryId] = useState<string | null>(
    null,
  );
  const [editingCategoryName, setEditingCategoryName] = useState("");
  const [pendingDelete, setPendingDelete] = useState<null | {
    type: "feed" | "category" | "label" | "saved-search" | "auto-read-rule" | "keyword-alert";
    id: string;
    name: string;
  }>(null);

  const [expandedCategories, setExpandedCategories] = useState<Set<string>>(new Set());

  const feedsByCategory = useMemo(() => {
    const groups: Record<string, any[]> = {};
    const uncategorized: any[] = [];
    feeds.forEach((feed) => {
      if (feed.categoryId) {
        if (!groups[feed.categoryId]) groups[feed.categoryId] = [];
        groups[feed.categoryId].push(feed);
      } else {
        uncategorized.push(feed);
      }
    });
    return { groups, uncategorized };
  }, [feeds]);

  const toggleCategory = (id: string) => {
    setExpandedCategories((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const [newRuleName, setNewRuleName] = useState("");
  const [newRuleQuery, setNewRuleQuery] = useState("");
  const [newRuleAction, setNewRuleAction] = useState("mark_read");
  const [newRuleActions, setNewRuleActions] = useState<string[]>(["mark_read"]);
  const [newRuleScope, setNewRuleScope] = useState<string>("all");
  const [newRuleTrigger, setNewRuleTrigger] = useState<"article" | "feed_error">("article");
  const [newRuleWebhooks, setNewRuleWebhooks] = useState<WebhookConfigUi[]>([]);
  const [newRuleRemoveSpoilerOnDelete, setNewRuleRemoveSpoilerOnDelete] = useState(false);
  const [rulePreview, setRulePreview] = useState<any[] | null>(null);
  const [showAddRule, setShowAddRule] = useState(false);
  const [showRuleTutorial, setShowRuleTutorial] = useState(false);
  const [editingRuleId, setEditingRuleId] = useState<string | null>(null);
  const [editRuleName, setEditRuleName] = useState("");
  const [editRuleQuery, setEditRuleQuery] = useState("");
  const [editRuleActions, setEditRuleActions] = useState<string[]>([]);
  const [editRuleScope, setEditRuleScope] = useState<string>("all");
  const [editRuleTrigger, setEditRuleTrigger] = useState<"article" | "feed_error">("article");
  const [editRuleWebhooks, setEditRuleWebhooks] = useState<WebhookConfigUi[]>([]);
  const [editRuleRemoveSpoilerOnDelete, setEditRuleRemoveSpoilerOnDelete] = useState(false);
  const [newAlertName, setNewAlertName] = useState("");
  const [newAlertQuery, setNewAlertQuery] = useState("");
  const [newAlertScope, setNewAlertScope] = useState("all");
  const [newAlertPush, setNewAlertPush] = useState(false);
  const [newAlertEmail, setNewAlertEmail] = useState(false);
  const [alertPreview, setAlertPreview] = useState<any[] | null>(null);
  const [showAddAlert, setShowAddAlert] = useState(false);
  const [editingAlertId, setEditingAlertId] = useState<string | null>(null);
  const [editAlertName, setEditAlertName] = useState("");
  const [editAlertQuery, setEditAlertQuery] = useState("");
  const [editAlertScope, setEditAlertScope] = useState("all");
  const [editAlertPush, setEditAlertPush] = useState(false);
  const [editAlertEmail, setEditAlertEmail] = useState(false);
  const [expandedHistoryId, setExpandedHistoryId] = useState<string | null>(null);
  const { data: alertHistory = [], isLoading: historyLoading } = useAlertHistory(expandedHistoryId);
  const [editingFeed, setEditingFeed] = useState<any | null>(null);
  const [selectedExportIds, setSelectedExportIds] = useState<Set<string>>(new Set());

  const { data: categories = [] } = useCategories();
  const { data: labels = [] } = useLabels();
  const { data: notificationChannels = DEFAULT_CHANNELS } = useNotificationChannelStatus();
  // webhook actions are now configured inline per rule (see ActionListEditor)
  const { data: savedSearches = [] } = useSavedSearches();

  useEffect(() => {
    if (open) setActiveTab(normalizeInitialTab(initialTab));
  }, [initialTab, open]);

  useEffect(() => {
    if (readingPreferences?.autoMuteFailingFeedsAfter !== undefined) {
      setAutoMuteThreshold(String(readingPreferences.autoMuteFailingFeedsAfter));
    }
  }, [readingPreferences?.autoMuteFailingFeedsAfter]);

  // Initialize all categories as expanded when categories (or feeds) load.
  // The `categories.length > 0` gate used to mean a user with NO categories
  // yet never got this at all — every group (including "Uncategorized", the
  // ONLY group they'd have) stayed collapsed from the initial empty Set,
  // which read as "no feeds" rather than "click to expand".
  useEffect(() => {
    if (categories.length > 0 || feedsByCategory.uncategorized.length > 0) {
      setExpandedCategories(new Set([...categories.map((c) => c.id), "__uncategorized__"]));
    }
  }, [categories.length, feedsByCategory.uncategorized.length]); // eslint-disable-line react-hooks/exhaustive-deps

  const searchParams = useSearchParams();
  const highlightFeedId = searchParams.get("feedId");

  useEffect(() => {
    if (!highlightFeedId || feeds.length === 0) return;
    setActiveTab("feeds");
    const feed = feeds.find((f) => f.id === highlightFeedId);
    const groupId = feed?.categoryId ?? "__uncategorized__";
    setExpandedCategories((prev) => {
      const next = new Set(prev);
      next.add(groupId);
      return next;
    });
    setTimeout(() => {
      const el = document.getElementById(`feed-row-${highlightFeedId}`);
      el?.scrollIntoView({ behavior: "smooth", block: "center" });
    }, 150);
  }, [highlightFeedId, feeds.length]); // eslint-disable-line react-hooks/exhaustive-deps

  const handleImport = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;

    const reader = new FileReader();
    reader.onload = async (event) => {
      const xml = event.target?.result as string;
      importOpml.mutate(xml, {
        onSuccess: (report) => {
          setLastImportReport(report);
          toast.success(t("toasts.importComplete", { added: report.feedsAdded, updated: report.feedsUpdated }));
        },
        onError: () => toast.error(t("toasts.failedToImport")),
      });
    };
    reader.readAsText(file);
  };

  const handleExport = () => {
    const ids = selectedExportIds.size > 0 ? Array.from(selectedExportIds) : undefined;
    exportOpml.mutate(ids, {
      onSuccess: (xml) => {
        const blob = new Blob([xml], { type: "text/xml" });
        const url = URL.createObjectURL(blob);
        const a = document.createElement("a");
        a.href = url;
        a.download = "feedferret_subscriptions.opml";
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        URL.revokeObjectURL(url);
        toast.success(ids ? t("importExport.exportFeedsCount", { count: ids.length }) : t("toasts.allFeedsExported"));
      },
      onError: () => toast.error(t("toasts.failedToExport")),
    });
  };

  const handleAddCategory = () => {
    if (!newCategoryName.trim()) return;
    addCategory.mutate(
      { name: newCategoryName },
      {
        onSuccess: () => {
          setNewCategoryName("");
          toast.success(t("toasts.categoryAdded"));
        },
      },
    );
  };

  const handleAddLabel = () => {
    if (!newLabelName.trim()) return;
    createLabel.mutate(
      { name: newLabelName, color: newLabelColor },
      {
        onSuccess: () => {
          setNewLabelName("");
          toast.success(t("toasts.labelAdded"));
        },
        onError: (error) => {
          toast.error(error instanceof Error ? error.message : t("toasts.failedToAddLabel"));
        },
      },
    );
  };

  const sensors = useSensors(
    useSensor(PointerSensor, {
      activationConstraint: {
        distance: 8,
      },
    }),
    useSensor(KeyboardSensor, {
      coordinateGetter: sortableKeyboardCoordinates,
    }),
  );

  const handleDragEnd = async (event: DragEndEvent) => {
    const { active, over } = event;
    if (!over) return;

    if (active.id !== over.id) {
      const activeCategory = categories.find((c: any) => c.id === active.id);
      const overCategory = categories.find((c: any) => c.id === over.id);

      if (activeCategory && overCategory) {
        // dropped on another category -> Nest
        await updateCategoryOrder.mutateAsync([
          {
            id: active.id as string,
            order: 0,
            parentId: over.id as string,
          },
        ]);
        toast.success(t("toasts.categoryMoved", { category: activeCategory.name, target: overCategory.name }));
        return;
      }
    }

    const oldIndex = categories.findIndex((c: any) => c.id === active.id);
    const newIndex = categories.findIndex((c: any) => c.id === over.id);

    if (oldIndex !== -1 && newIndex !== -1) {
      const newOrder = arrayMove(categories, oldIndex, newIndex);
      await updateCategoryOrder.mutateAsync(
        newOrder.map((c: any, i) => ({ id: c.id, order: i })),
      );
    }
  };

  const shellTabs = [
    { value: "feeds", label: t("feedsTab") },
    { value: "categories", label: t("categoriesTab") },
    { value: "opml", label: t("importExportTab") },
    { value: "labels", label: t("labelsAndSearchesTab") },
    { value: "health", label: t("healthTab") },
    { value: "rules", label: t("rulesAndAlertsTab") },
    // Keyword alerts are being migrated into the newer rules system (see the
    // migration banner in the "rules" tab below) and no longer get a
    // permanent tab of their own — but before/without migrating, users with
    // existing alerts still need a way to reach this UI to review, edit, or
    // delete them. Without this, it's dead, unreachable code once the
    // trigger disappears from the tab bar.
    ...(keywordAlerts.length > 0 ? [{ value: "alerts", label: t("alerts.keywordAlerts") }] : []),
  ];

  const shellProps = { title: t("title"), description: t("description"), activeTab, onTabChange: setActiveTab, tabs: shellTabs };

  const body = (
    <>
          <div className="flex-1 min-h-0">
            <TabsContent
              value="feeds"
              className="h-full mt-0 focus-visible:outline-none"
            >
              <ScrollArea className="h-full px-6 sm:px-8">
                <div className="space-y-4 pb-8">
                  {/* Category groups */}
                  {[
                    ...categories.map((cat: any) => ({
                      id: cat.id,
                      name: cat.name,
                      feeds: feedsByCategory.groups[cat.id] ?? [],
                    })),
                    ...(feedsByCategory.uncategorized.length > 0
                      ? [{ id: "__uncategorized__", name: t("feeds.uncategorizedLabel"), feeds: feedsByCategory.uncategorized }]
                      : []),
                  ].map(({ id: groupId, name: groupName, feeds: groupFeeds }) => {
                    const expanded = expandedCategories.has(groupId);
                    return (
                      <div key={groupId}>
                        <button
                          type="button"
                          onClick={() => toggleCategory(groupId)}
                          className="flex w-full items-center gap-2 py-1.5 text-start text-sm font-semibold text-muted-foreground hover:text-foreground transition-colors"
                        >
                          <ChevronRight className={cn("w-4 h-4 transition-transform duration-200", expanded && "rotate-90")} />
                          <Folder className="size-4 text-foreground" />
                          {groupName}
                          <span className="text-xs font-normal text-muted-foreground/60">({groupFeeds.length})</span>
                        </button>
                        {expanded && (
                          <div className="mt-1.5 space-y-2 ps-6 border-s-2 border-border/40">
                            {groupFeeds.map((feed: any) => (
                              <div
                                key={feed.id}
                                id={`feed-row-${feed.id}`}
                                className={cn(
                                  "flex flex-col gap-3 rounded-2xl border bg-card p-3.5 shadow-sm transition-all sm:flex-row sm:items-center",
                                  highlightFeedId === feed.id
                                    ? "border-primary/50 ring-2 ring-primary/20"
                                    : "border-border/60 hover:border-border",
                                )}
                              >
                                <div className="flex min-w-0 items-start gap-3 sm:flex-1">
                                  <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-background text-xl shadow-sm">
                                    {feed.icon || "📰"}
                                  </div>
                                  <div className="min-w-0 flex-1">
                                    <div className="truncate font-semibold tracking-[-0.01em] text-foreground text-sm">
                                      {feed.name}
                                    </div>
                                    <div className="truncate text-xs text-muted-foreground">
                                      {feed.url}
                                    </div>
                                    <div className="mt-0.5 flex flex-wrap gap-2 text-xs text-muted-foreground">
                                      <span>
                                        {t("feeds.lastSync")}{" "}
                                        {feed.lastFetchedAt
                                          ? format.dateTime(new Date(feed.lastFetchedAt), { dateStyle: "medium", timeStyle: "short" })
                                          : t("feeds.never")}
                                      </span>
                                      {feed.lastStatus === "error" && (
                                        <span className="text-destructive" title={feed.lastError || undefined}>
                                          {t("feeds.syncError")}
                                        </span>
                                      )}
                                    </div>
                                  </div>
                                </div>
                                <div className="grid w-full gap-2 sm:flex sm:w-auto sm:items-center">
                                  <Select
                                    value={feed.categoryId || "none"}
                                    onValueChange={(val: string) =>
                                      updateFeed.mutate({
                                        feedId: feed.id,
                                        data: { categoryId: val === "none" ? null : val },
                                      })
                                    }
                                  >
                                    <SelectTrigger className="h-11 w-full rounded-xl border-border/70 bg-background/70 shadow-sm text-xs sm:h-9 sm:w-32">
                                      <SelectValue placeholder={t("feeds.categoryPlaceholder")} />
                                    </SelectTrigger>
                                    <SelectContent className="rounded-2xl border-border/70 shadow-xl">
                                      <SelectItem value="none">{t("feeds.noCategory")}</SelectItem>
                                      {categories.map((cat: any) => (
                                        <SelectItem key={cat.id} value={cat.id}>
                                          {cat.name}
                                        </SelectItem>
                                      ))}
                                    </SelectContent>
                                  </Select>
                                  <div className="flex justify-end gap-1">
                                    <Button
                                      variant="ghost"
                                      size="sm"
                                      className="h-11 shrink-0 rounded-xl px-2.5 text-muted-foreground transition-all hover:bg-accent sm:h-9"
                                      title={t("feeds.settings")}
                                      onClick={() => setEditingFeed(feed)}
                                    >
                                      <Settings2 className="w-4 h-4" />
                                      <span className="ms-1.5 hidden lg:inline text-xs">{t("feeds.settings")}</span>
                                    </Button>
                                    <Button
                                      variant="ghost"
                                      size="sm"
                                      className="h-11 shrink-0 rounded-xl px-2.5 text-muted-foreground transition-all hover:bg-destructive/10 hover:text-destructive sm:h-9"
                                      onClick={() =>
                                        setPendingDelete({ type: "feed", id: feed.id, name: feed.name })
                                      }
                                    >
                                      <Trash2 className="w-4 h-4" />
                                      <span className="ms-1.5 hidden lg:inline text-xs">{t("feeds.delete")}</span>
                                    </Button>
                                  </div>
                                </div>
                              </div>
                            ))}
                            {groupFeeds.length === 0 && (
                              <p className="py-2 text-xs text-muted-foreground italic">{t("feeds.noFeedsInCategory")}</p>
                            )}
                          </div>
                        )}
                      </div>
                    );
                  })}
                  {feeds.length === 0 && (
                    <Empty className="my-4 border-0">
                      <EmptyMedia variant="icon"><Rss className="size-5" /></EmptyMedia>
                      <EmptyContent>
                        <EmptyTitle>{t("feeds.noFeedsYet")}</EmptyTitle>
                        <EmptyDescription>{t("feeds.addFirstFeed")}</EmptyDescription>
                      </EmptyContent>
                    </Empty>
                  )}
                </div>
              </ScrollArea>
            </TabsContent>

            <TabsContent
              value="categories"
              className="h-full mt-0 focus-visible:outline-none"
            >
              <div className="flex h-full flex-col px-6 sm:px-8">
                <div className="flex gap-2 mb-6">
                  <Input
                    placeholder={t("categories.newCategoryPlaceholder")}
                    value={newCategoryName}
                    onChange={(e) => setNewCategoryName(e.target.value)}
                    className="h-11 rounded-2xl border-border/70 bg-card focus-visible:ring-primary"
                  />
                  <Button
                    onClick={handleAddCategory}
                    className="h-11 rounded-2xl bg-primary px-6 transition-all hover:bg-primary/90 active:scale-95"
                  >
                    <FolderPlus className="w-4 h-4 me-2" />
                    {t("categories.addButton")}
                  </Button>
                </div>
                <ScrollArea className="flex-1 overflow-hidden min-h-0">
                  <DndContext
                    sensors={sensors}
                    collisionDetection={closestCorners}
                    onDragEnd={handleDragEnd}
                    modifiers={[restrictToVerticalAxis]}
                  >
                    <SortableContext
                      items={categories.map((c: any) => c.id)}
                      strategy={verticalListSortingStrategy}
                    >
                      <div className="space-y-3 pb-8">
                        {categories.map((cat: any) => (
                          <SortableCategoryItem
                            key={cat.id}
                            cat={cat}
                            editingCategoryId={editingCategoryId}
                            editingCategoryName={editingCategoryName}
                            setEditingCategoryName={setEditingCategoryName}
                            setEditingCategoryId={setEditingCategoryId}
                            updateCategory={updateCategory}
                            requestDelete={setPendingDelete}
                          />
                        ))}
                        {categories.length === 0 && (
                          <Empty className="my-4 border-0">
                            <EmptyMedia variant="icon"><Folder className="size-5" /></EmptyMedia>
                            <EmptyContent>
                              <EmptyTitle>{t("categories.noCategoriesYet")}</EmptyTitle>
                              <EmptyDescription>{t("categories.createCategory")}</EmptyDescription>
                            </EmptyContent>
                          </Empty>
                        )}
                      </div>
                    </SortableContext>
                  </DndContext>
                </ScrollArea>
              </div>
            </TabsContent>

            <TabsContent
              value="labels"
              className="h-full mt-0 focus-visible:outline-none"
            >
              <div className="grid h-full gap-6 px-6 py-4 sm:px-8 lg:grid-cols-2">
                <section className="min-h-0 rounded-2xl border border-border/60 bg-card p-5 shadow-sm">
                  <div className="mb-5 flex items-center gap-3">
                    <Tag className="h-5 w-5 text-primary" />
                    <div>
                      <h3 className="font-semibold tracking-[-0.02em]">{t("labels.title")}</h3>
                      <p className="text-sm text-muted-foreground">{t("labels.description")}</p>
                    </div>
                  </div>
                  <div className="mb-5 flex gap-2">
                    <Input
                      placeholder={t("labels.newLabelPlaceholder")}
                      value={newLabelName}
                      onChange={(e) => setNewLabelName(e.target.value)}
                      className="h-11 rounded-2xl border-border/70 bg-background/70"
                    />
                    <Input
                      type="color"
                      value={newLabelColor}
                      onChange={(e) => setNewLabelColor(e.target.value)}
                      className="h-11 w-14 rounded-2xl border-border/70 bg-background/70 p-1"
                    />
                    <Button onClick={handleAddLabel} className="h-11 rounded-2xl px-5">
                      {t("labels.addLabel")}
                    </Button>
                  </div>
                  <ScrollArea className="h-[48vh]">
                    <div className="space-y-2 pe-3">
                      {labels.map((label: any) => (
                        <div
                          key={label.id}
                          className="ui-control-surface flex items-center gap-3 rounded-2xl border p-3"
                        >
                          <span className="h-3 w-3 rounded-full" style={{ backgroundColor: label.color }} />
                          <span className="flex-1 truncate text-sm font-medium">{label.name}</span>
                          <span className="text-xs text-muted-foreground">{label._count?.articles || 0}</span>
                          <Button
                            variant="ghost"
                            size="icon"
                            className="h-11 w-11 rounded-xl text-muted-foreground hover:bg-destructive/10 hover:text-destructive sm:h-9 sm:w-9"
                            onClick={() => setPendingDelete({ type: "label", id: label.id, name: label.name })}
                          >
                            <Trash2 className="h-4 w-4" />
                          </Button>
                        </div>
                      ))}
                      {labels.length === 0 && (
                        <Empty className="my-4 border-0">
                          <EmptyMedia variant="icon"><Tag className="size-5" /></EmptyMedia>
                          <EmptyContent>
                            <EmptyTitle>{t("labels.noLabelsYet")}</EmptyTitle>
                            <EmptyDescription>{t("labels.labelDescription")}</EmptyDescription>
                          </EmptyContent>
                        </Empty>
                      )}
                    </div>
                  </ScrollArea>
                </section>

                <section className="min-h-0 rounded-2xl border border-border/60 bg-card p-5 shadow-sm">
                  <div className="mb-5 flex items-center gap-3">
                    <Bookmark className="h-5 w-5 text-primary" />
                    <div>
                      <h3 className="font-semibold tracking-[-0.02em]">{t("savedSearches.title")}</h3>
                      <p className="text-sm text-muted-foreground">{t("savedSearches.description")}</p>
                    </div>
                  </div>
                  <ScrollArea className="h-[56vh]">
                    <div className="space-y-2 pe-3">
                      {savedSearches.map((search: any) => {
                        const shareOrigin = typeof window !== "undefined" ? window.location.origin : "";
                        const shareUrl = search.shareToken
                          ? `${shareOrigin}/shared/search/${search.shareToken}`
                          : "";
                        const rssUrl = search.shareToken
                          ? `${shareOrigin}/api/shared-search/${search.shareToken}/rss`
                          : "";

                        return (
                        <div
                          key={search.id}
                          className="ui-control-surface rounded-2xl border p-3"
                        >
                          <div className="flex items-center gap-3">
                            <span className="flex-1 truncate text-sm font-medium">{search.name}</span>
                            <Button
                              variant="ghost"
                              size="icon"
                              className="h-11 w-11 rounded-xl text-muted-foreground hover:bg-accent/10 hover:text-accent sm:h-9 sm:w-9"
                              onClick={() => setSavedSearchSharing.mutate({ searchId: search.id, enabled: !search.shareToken })}
                              title={search.shareToken ? t("savedSearches.disableSharing") : t("savedSearches.enableSharing")}
                            >
                              {search.shareToken ? <LinkIcon className="h-4 w-4" /> : <Share2 className="h-4 w-4" />}
                            </Button>
                            <Button
                              variant="ghost"
                              size="icon"
                              className="h-11 w-11 rounded-xl text-muted-foreground hover:bg-destructive/10 hover:text-destructive sm:h-9 sm:w-9"
                              onClick={() => setPendingDelete({ type: "saved-search", id: search.id, name: search.name })}
                            >
                              <Trash2 className="h-4 w-4" />
                            </Button>
                          </div>
                          <code className="mt-2 block truncate rounded-xl bg-muted/50 px-2 py-1 text-xs text-muted-foreground">
                            {search.query}
                          </code>
                          {search.shareToken && (
                            <div className="mt-3 rounded-xl border border-border/50 bg-muted/25 p-2">
                              <div className="mb-2 flex items-center gap-2 text-xs font-medium text-muted-foreground">
                                <LinkIcon className="size-4" />
                                {t("savedSearches.sharedReadOnlyLink")}
                              </div>
                              <div className="flex flex-wrap gap-1.5">
                                <Button
                                  variant="outline"
                                  size="sm"
                                  className="h-8 rounded-xl"
                                  onClick={() => { navigator.clipboard.writeText(shareUrl); toast.success(t("toasts.sharingEnabled")); }}
                                >
                                  <Copy className="me-1.5 size-4" />
                                  {t("savedSearches.copy")}
                                </Button>
                                <Button asChild variant="outline" size="sm" className="h-8 rounded-xl">
                                  <a href={shareUrl} target="_blank" rel="noreferrer">
                                    <ExternalLink className="me-1.5 size-4" />
                                    {t("savedSearches.open")}
                                  </a>
                                </Button>
                                <Button asChild variant="outline" size="sm" className="h-8 rounded-xl">
                                  <a href={rssUrl} target="_blank" rel="noreferrer">
                                    <Rss className="me-1.5 size-4" />
                                    {t("savedSearches.rss")}
                                  </a>
                                </Button>
                              </div>
                            </div>
                          )}
                        </div>
                      )})}
                      {savedSearches.length === 0 && (
                        <Empty className="my-4 border-0">
                          <EmptyMedia variant="icon"><Bookmark className="size-5" /></EmptyMedia>
                          <EmptyContent>
                            <EmptyTitle>{t("savedSearches.noSavedSearches")}</EmptyTitle>
                            <EmptyDescription>{t("savedSearches.useSaveQuery")}</EmptyDescription>
                          </EmptyContent>
                        </Empty>
                      )}
                    </div>
                  </ScrollArea>
                </section>
              </div>
            </TabsContent>

            <TabsContent
              value="health"
              className="h-full mt-0 focus-visible:outline-none"
            >
              <div className="flex h-full flex-col px-6 py-4 sm:px-8">
                <div className="mb-5 flex flex-col gap-4 rounded-2xl border border-border/60 bg-card p-5 shadow-sm sm:flex-row sm:items-center sm:justify-between">
                  <div className="flex items-center gap-3">
                    <Activity className="h-5 w-5 text-primary" />
                    <div>
                      <h3 className="font-semibold tracking-[-0.02em]">{t("health.title")}</h3>
                      <p className="text-sm text-muted-foreground">{t("health.description")}</p>
                    </div>
                  </div>
                  <div className="flex w-full flex-col gap-2 sm:w-auto sm:flex-row sm:items-center">
                    <Button
                      variant="outline"
                      onClick={() => applyRetention.mutate(true)}
                      disabled={applyRetention.isPending}
                      className="w-full rounded-2xl sm:w-auto"
                    >
                      {t("health.dryRun")}
                    </Button>
                    <Button
                      onClick={() => applyRetention.mutate(false)}
                      disabled={applyRetention.isPending}
                      className="w-full rounded-2xl sm:w-auto"
                    >
                      <ShieldCheck className="me-2 h-4 w-4" />
                      {t("health.applyRetention")}
                    </Button>
                  </div>
                </div>

                {/* F6: auto-mute threshold — 0 disables it entirely */}
                <div className="mb-5 flex flex-col gap-3 rounded-2xl border border-border/60 bg-card p-4 shadow-sm sm:flex-row sm:items-center sm:justify-between">
                  <div className="flex items-center gap-3">
                    <BellOff className="h-4 w-4 shrink-0 text-muted-foreground" />
                    <div>
                      <p className="text-sm font-medium">{t("health.autoMuteThresholdLabel")}</p>
                      <p className="text-xs text-muted-foreground">{t("health.autoMuteThresholdHint")}</p>
                    </div>
                  </div>
                  <div className="flex items-center gap-2">
                    <Input
                      type="number"
                      min={0}
                      value={autoMuteThreshold}
                      onChange={(e) => setAutoMuteThreshold(e.target.value)}
                      onBlur={() => {
                        const parsed = parseInt(autoMuteThreshold, 10);
                        updateGlobalSettings.mutate({
                          autoMuteFailingFeedsAfter: Number.isFinite(parsed) ? Math.max(0, parsed) : 0,
                        });
                      }}
                      className="h-9 w-24 rounded-xl"
                    />
                    <span className="text-xs text-muted-foreground">{t("health.autoMuteThresholdSuffix")}</span>
                  </div>
                </div>

                <ScrollArea className="min-h-0 flex-1">
                  <div className="space-y-3 pb-8 pe-3">
                    {feedHealth.map((feed: any) => (
                      <div key={feed.id} className="rounded-2xl border border-border/60 bg-card p-4 shadow-sm">
                        <div className="flex flex-col gap-4 sm:flex-row sm:items-start">
                          <div className="flex h-10 w-10 items-center justify-center rounded-2xl bg-background text-2xl shadow-sm">
                            {feed.icon || "📰"}
                          </div>
                          <div className="min-w-0 flex-1">
                            <div className="flex flex-wrap items-center gap-2">
                              <h4 className="truncate font-semibold tracking-[-0.01em]">{feed.name}</h4>
                              <span className={cn(
                                "rounded-full px-2 py-0.5 text-[10px] font-bold uppercase",
                                feed.lastStatus === "error"
                                  ? "bg-destructive/10 text-destructive"
                                  : "bg-green-500/10 text-green-600",
                              )}>
                                {feed.lastStatus || "unknown"}
                              </span>
                              {feed.autoMuted && (
                                <span className="inline-flex items-center gap-1 rounded-full bg-amber-500/10 px-2 py-0.5 text-[10px] font-bold uppercase text-amber-600">
                                  <BellOff className="h-2.5 w-2.5" />
                                  {t("health.autoMuted")}
                                </span>
                              )}
                            </div>
                            <p className="mt-1 truncate text-xs text-muted-foreground">{feed.url}</p>
                            <div className="mt-3 grid grid-cols-1 gap-2 text-xs text-muted-foreground sm:grid-cols-2 lg:grid-cols-5">
                              <span>{feed.articleCount} {t("health.articles")}</span>
                              <span>{feed.unreadCount} {t("health.unread")}</span>
                              <span>{feed.avgArticlesPerDay != null ? `${feed.avgArticlesPerDay}${t("health.perDay")}` : "—"}</span>
                              <span>{t("health.sync")} {feed.lastFetchedAt ? format.dateTime(new Date(feed.lastFetchedAt), { dateStyle: "medium", timeStyle: "short" }) : t("feeds.never")}</span>
                              <span>{feed.retentionDays ? t("health.retentionDays", { count: feed.retentionDays }) : t("health.retentionDefault")}</span>
                            </div>
                            {feed.consecutiveFailureCount > 0 && (
                              <p className="mt-2 text-xs text-muted-foreground">
                                {t("health.consecutiveFailures", { count: feed.consecutiveFailureCount })}
                              </p>
                            )}
                            {feed.lastError && (
                              <p className="mt-3 rounded-2xl bg-destructive/10 px-3 py-2 text-xs text-destructive">
                                {feed.lastError}
                              </p>
                            )}
                            <div className="mt-3">
                              <Button
                                size="sm"
                                variant="outline"
                                className="rounded-xl"
                                onClick={() => updateFeed.mutate({ feedId: feed.id, data: { autoMuted: !feed.autoMuted } })}
                                disabled={updateFeed.isPending}
                              >
                                <BellOff className="me-1.5 h-3.5 w-3.5" />
                                {feed.autoMuted ? t("health.unmuteButton") : t("health.muteButton")}
                              </Button>
                            </div>
                          </div>
                        </div>
                      </div>
                    ))}
                  </div>
                </ScrollArea>
              </div>
            </TabsContent>

            <TabsContent
              value="opml"
              className="h-full mt-0 focus-visible:outline-none"
            >
              <ScrollArea className="h-full px-6 sm:px-8">
              <div className="space-y-6 py-4 pb-8">
                <MigrationWizard onUpload={handleImport} isImporting={importOpml.isPending} />

                <div className="space-y-4 rounded-2xl border border-border/60 bg-card p-7 shadow-sm">
                  <div className="flex items-center gap-3 text-xl font-semibold tracking-[-0.02em] text-primary">
                    <Upload className="w-6 h-6" />
                    {t("importExport.genericOpmlImport")}
                  </div>
                  <p className="text-muted-foreground">
                    {t("importExport.alreadyHaveOpml")}
                  </p>
                  {lastImportReport && (
                    <div className="rounded-2xl border border-border/60 bg-background/70 p-4 text-sm space-y-2">
                      <p className="font-medium">{t("importExport.importResult")}</p>
                      <div className="flex flex-wrap gap-3 text-xs">
                        <span className="rounded-full bg-green-500/10 text-green-600 px-2.5 py-1 font-medium">
                          +{lastImportReport.feedsAdded} {t("importExport.new")}
                        </span>
                        <span className="rounded-full bg-accent/10 text-foreground px-2.5 py-1 font-medium">
                          {lastImportReport.feedsUpdated} {t("importExport.alreadyExisted")}
                        </span>
                        <span className="rounded-full bg-muted text-muted-foreground px-2.5 py-1 font-medium">
                          {lastImportReport.categoriesAdded} {t("importExport.categories")}
                        </span>
                        {lastImportReport.errors.length > 0 && (
                          <span className="rounded-full bg-destructive/10 text-destructive px-2.5 py-1 font-medium">
                            {lastImportReport.errors.length} {t("importExport.errors")}
                          </span>
                        )}
                      </div>
                      {lastImportReport.errors.length > 0 && (
                        <ul className="mt-2 space-y-1">
                          {lastImportReport.errors.slice(0, 5).map((err: string, i: number) => (
                            <li key={i} className="text-xs text-destructive truncate">{err}</li>
                          ))}
                        </ul>
                      )}
                    </div>
                  )}
                  <Label htmlFor="opml-upload" className="block">
                    <div className="inline-flex h-12 cursor-pointer items-center justify-center rounded-2xl bg-primary px-8 text-sm font-medium text-primary-foreground shadow-sm transition-all hover:bg-primary/90 active:scale-95">
                      {t("importExport.selectOpmlFile")}
                    </div>
                    <Input
                      id="opml-upload"
                      type="file"
                      accept=".xml,.opml"
                      className="hidden"
                      onChange={handleImport}
                    />
                  </Label>
                </div>

                <div className="space-y-4 rounded-2xl border border-border/60 bg-card p-7 shadow-sm">
                  <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
                    <div className="flex items-center gap-3 text-xl font-semibold tracking-[-0.02em]">
                      <Download className="w-6 h-6 text-muted-foreground" />
                      {t("importExport.exportSubscriptions")}
                    </div>
                    <div className="flex gap-2 text-xs">
                      <button
                        className="text-link hover:underline"
                        onClick={() => setSelectedExportIds(new Set(feeds.map((f: any) => f.id)))}
                      >
                        {t("importExport.selectAll")}
                      </button>
                      <span className="text-muted-foreground">·</span>
                      <button
                        className="text-muted-foreground hover:underline"
                        onClick={() => setSelectedExportIds(new Set())}
                      >
                        {t("importExport.deselectAll")}
                      </button>
                    </div>
                  </div>
                  <p className="text-muted-foreground text-sm">
                    {t("importExport.selectFeedsToExport")}
                  </p>
                  <div className="max-h-48 overflow-y-auto rounded-2xl border border-border/60 bg-background/40 divide-y divide-border/40">
                    {feeds.map((feed: any) => (
                      <label key={feed.id} className="flex items-center gap-3 px-4 py-2.5 cursor-pointer hover:bg-muted/30">
                        <input
                          type="checkbox"
                          className="rounded"
                          checked={selectedExportIds.has(feed.id)}
                          onChange={(e) => {
                            const next = new Set(selectedExportIds);
                            if (e.target.checked) next.add(feed.id);
                            else next.delete(feed.id);
                            setSelectedExportIds(next);
                          }}
                        />
                        <span className="text-sm truncate flex-1">{feed.name}</span>
                        {feed.category && (
                          <span className="text-xs text-muted-foreground shrink-0">{feed.category.name}</span>
                        )}
                      </label>
                    ))}
                  </div>
                  <div className="flex flex-col gap-3 sm:flex-row sm:items-center">
                    <Button
                      onClick={handleExport}
                      variant="outline"
                      disabled={exportOpml.isPending}
                      className="h-12 rounded-2xl border-border/70 bg-background/70 px-8 shadow-sm transition-all hover:bg-background active:scale-95"
                    >
                      {selectedExportIds.size > 0 ? t("importExport.exportFeedsCount", { count: selectedExportIds.size }) : t("importExport.exportAllFeeds")}
                    </Button>
                  </div>
                </div>

                <div className="space-y-4 rounded-2xl border border-border/60 bg-card p-7 shadow-sm">
                  <div className="flex items-center gap-3 text-xl font-semibold tracking-[-0.02em]">
                    <Download className="w-6 h-6 text-muted-foreground" />
                    {t("importExport.exportAllDataJson")}
                  </div>
                  <p className="text-muted-foreground">
                    {t("importExport.downloadFeedsJson")}
                  </p>
                  <Button
                    variant="outline"
                    className="h-12 rounded-2xl border-border/70 bg-background/70 px-8 shadow-sm transition-all hover:bg-background active:scale-95"
                    disabled={exportUserData.isPending}
                    onClick={() =>
                      exportUserData.mutate(undefined, {
                        onSuccess: (json) => {
                          const blob = new Blob([json], { type: "application/json" });
                          const url = URL.createObjectURL(blob);
                          const a = document.createElement("a");
                          a.href = url;
                          a.download = `feedferret-export-${new Date().toISOString().split("T")[0]}.json`;
                          document.body.appendChild(a);
                          a.click();
                          document.body.removeChild(a);
                          URL.revokeObjectURL(url);
                          toast.success(t("toasts.dataExported"));
                        },
                      })
                    }
                  >
                    {t("importExport.exportJson")}
                  </Button>
                </div>
              </div>
              </ScrollArea>
            </TabsContent>

            <TabsContent
              value="rules"
              className="h-full mt-0 focus-visible:outline-none"
            >
              <ScrollArea className="h-full px-6 sm:px-8">
                <div className="space-y-6 py-4 pb-8">
                  <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
                    <div>
                      <h3 className="text-lg font-semibold tracking-tight">{t("rules.title")}</h3>
                      <p className="text-sm text-muted-foreground mt-0.5">
                        {t("rules.description")}
                      </p>
                    </div>
                    <div className="flex w-full flex-col gap-2 sm:w-auto sm:flex-row">
                      <Button
                        size="sm"
                        variant="outline"
                        className="w-full rounded-xl gap-1.5 sm:w-auto"
                        onClick={() => applyAutoReadRulesNow.mutate()}
                        disabled={applyAutoReadRulesNow.isPending}
                      >
                        <Play className="size-4" />
                        {t("rules.runNow")}
                      </Button>
                      <Button
                        size="sm"
                        className="w-full rounded-xl gap-1.5 sm:w-auto"
                        onClick={() => setShowAddRule(true)}
                      >
                        <Plus className="size-4" />
                        {t("rules.addRule")}
                      </Button>
                    </div>
                  </div>

                  {/* text-*-700 in light mode / dark:text-*-400 in dark mode:
                      the -400 shades alone read fine on a dark background but
                      have poor contrast against a light one — same fix as the
                      privacy-warning banners elsewhere in settings. */}
                  <div className="rounded-2xl border border-blue-500/20 bg-blue-500/5 p-4 space-y-3">
                    <button
                      type="button"
                      onClick={() => setShowRuleTutorial((v) => !v)}
                      className="flex w-full items-center justify-between gap-2 text-sm font-medium text-blue-700 dark:text-blue-400 active:scale-[0.99] transition-transform"
                      aria-expanded={showRuleTutorial}
                    >
                      <span className="flex items-center gap-2">
                        <Info className="w-4 h-4 shrink-0" />
                        {t("rules.howRulesWork")}
                      </span>
                      <span className="text-xs text-blue-700/70 dark:text-blue-300/70">
                        {showRuleTutorial ? t("rules.hide") : t("rules.show")}
                      </span>
                    </button>
                    {showRuleTutorial && (
                    <div className="space-y-3 text-xs text-muted-foreground leading-relaxed">
                      <p>{t("rules.rulesExplanation")}</p>

                      <div>
                        <p className="font-medium text-foreground/80 mb-1.5">Examples</p>
                        <div className="space-y-1.5 font-mono">
                          <div className="flex flex-col gap-0.5">
                            <code className="text-foreground/80">feed:&quot;Hacker News&quot; is:unread</code>
                            <span className="font-sans">→ target unread articles from a specific feed (quote multi-word values)</span>
                          </div>
                          <div className="flex flex-col gap-0.5">
                            <code className="text-foreground/80">intitle:AI intitle:LLM</code>
                            <span className="font-sans">→ matches headlines containing both AI and LLM</span>
                          </div>
                          <div className="flex flex-col gap-0.5">
                            <code className="text-foreground/80">category:News author:Reuters</code>
                            <span className="font-sans">→ wire news from Reuters in the News category</span>
                          </div>
                          <div className="flex flex-col gap-0.5">
                            <code className="text-foreground/80">intitle:sponsored OR intitle:&quot;press release&quot;</code>
                            <span className="font-sans">→ auto-read promotional posts</span>
                          </div>
                          <div className="flex flex-col gap-0.5">
                            <code className="text-foreground/80">after:7d -is:starred</code>
                            <span className="font-sans">→ recent articles you haven&apos;t starred</span>
                          </div>
                        </div>
                      </div>

                      <div>
                        <p className="font-medium text-foreground/80 mb-1.5">Available operators</p>
                        <ul className="grid grid-cols-1 sm:grid-cols-2 gap-x-4 gap-y-1 list-none">
                          <li><code className="bg-background/60 px-1 rounded">intitle:</code> / <code className="bg-background/60 px-1 rounded">title:</code> — match in title</li>
                          <li><code className="bg-background/60 px-1 rounded">intext:</code> / <code className="bg-background/60 px-1 rounded">content:</code> — body / excerpt</li>
                          <li><code className="bg-background/60 px-1 rounded">author:</code> / <code className="bg-background/60 px-1 rounded">by:</code> — author</li>
                          <li><code className="bg-background/60 px-1 rounded">inurl:</code> / <code className="bg-background/60 px-1 rounded">link:</code> — article URL</li>
                          <li><code className="bg-background/60 px-1 rounded">feed:</code> / <code className="bg-background/60 px-1 rounded">f:</code> — feed name, id or url</li>
                          <li><code className="bg-background/60 px-1 rounded">category:</code> / <code className="bg-background/60 px-1 rounded">cat:</code> — category</li>
                          <li><code className="bg-background/60 px-1 rounded">label:</code> / <code className="bg-background/60 px-1 rounded">tag:</code> or <code className="bg-background/60 px-1 rounded">#name</code></li>
                          <li><code className="bg-background/60 px-1 rounded">is:unread</code> · <code className="bg-background/60 px-1 rounded">is:read</code></li>
                          <li><code className="bg-background/60 px-1 rounded">is:starred</code> · <code className="bg-background/60 px-1 rounded">is:unstarred</code></li>
                          <li><code className="bg-background/60 px-1 rounded">is:readlater</code></li>
                          <li><code className="bg-background/60 px-1 rounded">after:</code> / <code className="bg-background/60 px-1 rounded">since:</code></li>
                          <li><code className="bg-background/60 px-1 rounded">before:</code> / <code className="bg-background/60 px-1 rounded">until:</code></li>
                          <li><code className="bg-background/60 px-1 rounded">date:</code> / <code className="bg-background/60 px-1 rounded">pubdate:</code></li>
                        </ul>
                      </div>

                      <div className="space-y-1">
                        <p><strong className="text-foreground/70">Modifiers</strong></p>
                        <ul className="space-y-0.5">
                          <li>– Multiple terms = AND. Use <code className="bg-background/60 px-1 rounded">OR</code> (uppercase) to allow either.</li>
                          <li>– Prefix <code className="bg-background/60 px-1 rounded">-</code> or <code className="bg-background/60 px-1 rounded">!</code> to exclude — <code className="bg-background/60 px-1 rounded">-intitle:sponsored</code>.</li>
                          <li>– Quote multi-word values: <code className="bg-background/60 px-1 rounded">feed:&quot;The Verge&quot;</code>.</li>
                          <li>– Dates accept ISO (<code className="bg-background/60 px-1 rounded">2026-01-15</code>) or relative (<code className="bg-background/60 px-1 rounded">7d</code>, <code className="bg-background/60 px-1 rounded">2w</code>, <code className="bg-background/60 px-1 rounded">3m</code>, <code className="bg-background/60 px-1 rounded">1y</code>).</li>
                          <li>– Plain words (no <code className="bg-background/60 px-1 rounded">key:</code>) search across title, content, author, url and labels.</li>
                        </ul>
                      </div>
                    </div>
                    )}
                  </div>

                  {showAddRule && (
                    <div className="rounded-2xl border border-border/60 bg-card p-5 space-y-4">
                      <h4 className="font-medium text-sm">{t("rules.newRule")}</h4>
                      <div className="grid gap-3">
                        <Input
                          placeholder={t("rules.ruleNamePlaceholder")}
                          value={newRuleName}
                          onChange={(e) => setNewRuleName(e.target.value)}
                          className="rounded-xl h-10"
                        />
                        <div className="grid gap-2 sm:grid-cols-[160px_1fr]">
                          <label htmlFor="new-rule-trigger-select" className="text-xs font-medium text-muted-foreground self-center">{t("rules.trigger")}</label>
                          <Select
                            value={newRuleTrigger}
                            onValueChange={(value) => {
                              const trigger = value === "feed_error" ? "feed_error" : "article";
                              setNewRuleTrigger(trigger);
                              const filtered = catalogForTrigger(buildActionCatalog(labels, t, notificationChannels), trigger);
                              const allowed = new Set(filtered.map((i) => i.value));
                              const survived = newRuleActions.filter(
                                (a) => allowed.has(a) || a.startsWith("webhook_call:") || a.startsWith("label:") || a.startsWith("remove_label:"),
                              );
                              const finalActions =
                                survived.length === 0
                                  ? trigger === "feed_error"
                                    ? ["notify_inapp"]
                                    : ["mark_read"]
                                  : survived;
                              const packed = repackWebhooks(finalActions, newRuleWebhooks);
                              setNewRuleActions(packed.actions);
                              setNewRuleWebhooks(packed.webhookConfigs);
                              setNewRuleAction(packed.actions[0] || "mark_read");
                            }}
                          >
                            <SelectTrigger id="new-rule-trigger-select" className="rounded-xl h-10">
                              <SelectValue />
                            </SelectTrigger>
                            <SelectContent>
                              <SelectItem value="article">{t("rules.articleMatches")}</SelectItem>
                              <SelectItem value="feed_error">{t("rules.feedFails")}</SelectItem>
                            </SelectContent>
                          </Select>
                        </div>
                        {newRuleTrigger === "article" && (
                          <div className="flex flex-col gap-2 sm:flex-row">
                            <Input
                              placeholder={t("rules.queryPlaceholder")}
                              value={newRuleQuery}
                              onChange={(e) => {
                                setNewRuleQuery(e.target.value);
                                setRulePreview(null);
                              }}
                              className="rounded-xl h-10 flex-1"
                            />
                            <Button
                              size="sm"
                              variant="outline"
                              className="rounded-xl shrink-0 gap-1.5"
                              disabled={!newRuleQuery.trim() || previewAutoReadRule.isPending}
                              onClick={() =>
                                previewAutoReadRule.mutate(
                                  { query: newRuleQuery, scope: newRuleScope === "all" ? null : newRuleScope },
                                  { onSuccess: (data) => setRulePreview(data) },
                                )
                              }
                            >
                              <Eye className="size-4" />
                              {t("rules.preview")}
                            </Button>
                          </div>
                        )}
                        <div className="grid gap-2 sm:grid-cols-[160px_1fr]">
                          <label htmlFor="new-rule-scope-select" className="text-xs font-medium text-muted-foreground self-center">{t("rules.scope")}</label>
                          <Select value={newRuleScope} onValueChange={setNewRuleScope}>
                            <SelectTrigger id="new-rule-scope-select" className="rounded-xl h-10">
                              <SelectValue />
                            </SelectTrigger>
                            <SelectContent>
                              <SelectItem value="all">{newRuleTrigger === "feed_error" ? t("rules.anyFeed") : t("rules.allArticles")}</SelectItem>
                              {feeds.map((feed) => (
                                <SelectItem key={`scope-feed-${feed.id}`} value={`feed:${feed.id}`}>{t("rules.feedScope", { name: feed.name })}</SelectItem>
                              ))}
                              {categories.map((c) => (
                                <SelectItem key={`scope-cat-${c.id}`} value={`category:${c.id}`}>{t("rules.categoryScope", { name: c.name })}</SelectItem>
                              ))}
                            </SelectContent>
                          </Select>
                        </div>
                        <div className="space-y-1.5">
                          <label className="text-xs font-medium text-muted-foreground">
                            {t("rules.actionsRunInOrder")}
                            {newRuleTrigger === "feed_error" && (
                              <span className="ms-2 text-xs font-semibold uppercase tracking-wider text-amber-500">{t("rules.notifyWebhookOnly")}</span>
                            )}
                          </label>
                          <ActionListEditor
                            value={newRuleActions}
                            webhookConfigs={newRuleWebhooks}
                            onChange={({ actions, webhookConfigs }) => {
                              setNewRuleActions(actions);
                              setNewRuleWebhooks(webhookConfigs);
                              setNewRuleAction(actions[0] || "mark_read");
                            }}
                            catalog={catalogForTrigger(buildActionCatalog(labels, t, notificationChannels), newRuleTrigger)}
                            labels={labels}
                          />
                          {newRuleActions.includes("mark_spoiler") && (
                            <label htmlFor="new-rule-remove-spoiler-checkbox" className="flex items-center gap-2 cursor-pointer select-none mt-1">
                              <Checkbox
                                id="new-rule-remove-spoiler-checkbox"
                                checked={newRuleRemoveSpoilerOnDelete}
                                onCheckedChange={(v) => setNewRuleRemoveSpoilerOnDelete(!!v)}
                              />
                              <span className="text-xs text-muted-foreground">{t("rules.removeSpoilerOnDeleteLabel")}</span>
                            </label>
                          )}
                        </div>
                      </div>

                      {rulePreview !== null && (
                        <div className="rounded-xl bg-muted/40 p-3 text-sm">
                          {rulePreview.length === 0 ? (
                            <p className="text-muted-foreground italic">{t("rules.noMatchingArticles")}</p>
                          ) : (
                            <div className="space-y-1">
                              <p className="font-medium text-xs text-muted-foreground uppercase tracking-wide mb-2">
                                {t("rules.matchingArticle", { count: rulePreview.length })}
                              </p>
                              {rulePreview.map((a: any) => (
                                <div key={a.id} className="flex items-center gap-2">
                                  <span className="text-xs text-muted-foreground shrink-0">
                                    {a.feedName}
                                  </span>
                                  <span className="truncate text-sm">{a.title}</span>
                                </div>
                              ))}
                            </div>
                          )}
                        </div>
                      )}

                      <div className="flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
                        <Button
                          size="sm"
                          variant="ghost"
                          className="rounded-xl"
                          onClick={() => {
                            setShowAddRule(false);
                            setNewRuleName("");
                            setNewRuleQuery("");
                            setNewRuleAction("mark_read");
                            setNewRuleActions(["mark_read"]);
                            setNewRuleScope("all");
                            setNewRuleTrigger("article");
                            setNewRuleWebhooks([]);
                            setRulePreview(null);
                          }}
                        >
                          {t("rules.closeEditor")}
                        </Button>
                        <Button
                          size="sm"
                          className="rounded-xl"
                          disabled={
                            !newRuleName.trim() ||
                            (newRuleTrigger === "article" && !newRuleQuery.trim()) ||
                            newRuleActions.length === 0 ||
                            createAutoReadRule.isPending
                          }
                          onClick={() =>
                            createAutoReadRule.mutate(
                              {
                                name: newRuleName.trim(),
                                query: newRuleQuery.trim(),
                                actions: newRuleActions,
                                scope: newRuleScope === "all" ? null : newRuleScope,
                                trigger: newRuleTrigger,
                                webhookConfigs: newRuleWebhooks,
                                removeSpoilerOnDelete: newRuleRemoveSpoilerOnDelete,
                              },
                              {
                                onSuccess: () => {
                                  setShowAddRule(false);
                                  setNewRuleName("");
                                  setNewRuleQuery("");
                                  setNewRuleAction("mark_read");
                                  setNewRuleActions(["mark_read"]);
                                  setNewRuleScope("all");
                                  setNewRuleTrigger("article");
                                  setNewRuleWebhooks([]);
                                  setNewRuleRemoveSpoilerOnDelete(false);
                                  setRulePreview(null);
                                },
                              },
                            )
                          }
                        >
                          {t("rules.saveRule")}
                        </Button>
                      </div>
                    </div>
                  )}

                  {keywordAlerts.length > 0 && (
                    <div className="rounded-2xl border border-amber-500/30 bg-amber-500/5 p-4 flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
                      <div>
                        <p className="text-sm font-medium text-amber-600 dark:text-amber-400">
                          {t("rules.legacyAlertsFound", { count: keywordAlerts.length })}
                        </p>
                        <p className="text-xs text-muted-foreground mt-0.5">
                          {t("rules.alertsAndRulesMerged")}
                        </p>
                      </div>
                      <Button
                        size="sm"
                        className="rounded-xl shrink-0"
                        disabled={migrateAlertsToRules.isPending}
                        onClick={() => migrateAlertsToRules.mutate()}
                      >
                        {migrateAlertsToRules.isPending ? t("rules.migrating") : t("rules.migrateToRules")}
                      </Button>
                    </div>
                  )}

                  {autoReadRules.length === 0 && !showAddRule ? (
                    <Empty>
                      <EmptyMedia variant="icon"><Play className="size-5" /></EmptyMedia>
                      <EmptyContent>
                        <EmptyTitle>{t("rules.noRulesYet")}</EmptyTitle>
                        <EmptyDescription>{t("rules.rulesAutoRun")}</EmptyDescription>
                      </EmptyContent>
                    </Empty>
                  ) : (
                    <div className="space-y-2">
                      {autoReadRules.map((rule: any) => {
                        const catalog = buildActionCatalog(labels, t, notificationChannels);
                        const ruleActions: string[] = (() => {
                          if (rule.actions) {
                            try {
                              const parsed = JSON.parse(rule.actions);
                              if (Array.isArray(parsed)) return parsed.filter((x: any) => typeof x === "string");
                            } catch {}
                          }
                          return rule.action ? [rule.action] : [];
                        })();
                        const scopeLabel = (() => {
                          const s = rule.scope as string | null | undefined;
                          if (!s || s === "all") return null;
                          if (s.startsWith("feed:")) {
                            const fid = s.slice("feed:".length);
                            const f = feeds.find((x) => x.id === fid);
                            return t("rules.feedScope", { name: f?.name ?? "?" });
                          }
                          if (s.startsWith("category:")) {
                            const cid = s.slice("category:".length);
                            const c = categories.find((x) => x.id === cid);
                            return t("rules.categoryScope", { name: c?.name ?? "?" });
                          }
                          return s;
                        })();
                        const isEditing = editingRuleId === rule.id;

                        return (
                          <div
                            key={rule.id}
                            className="rounded-2xl border border-border/60 bg-card px-4 py-3 space-y-3"
                          >
                            <div className="flex flex-col gap-3 sm:flex-row sm:items-center">
                              <button
                                onClick={() =>
                                  updateAutoReadRule.mutate({
                                    ruleId: rule.id,
                                    data: { enabled: !rule.enabled },
                                  })
                                }
                                className={cn(
                                  "shrink-0 rounded-lg p-1.5 transition-colors",
                                  rule.enabled
                                    ? "bg-primary text-primary-foreground"
                                    : "text-muted-foreground/50 bg-muted",
                                )}
                                title={rule.enabled ? t("rules.disableRule") : t("rules.enableRule")}
                              >
                                <Power className="size-4" />
                              </button>
                              <div className="flex-1 min-w-0">
                                <p className="font-medium text-sm truncate">{rule.name}</p>
                                <p className="text-xs text-muted-foreground font-mono truncate">{rule.query}</p>
                                <div className="mt-1.5 flex flex-wrap gap-1">
                                  <span
                                    className={cn(
                                      "text-[10px] px-1.5 py-0.5 rounded-full",
                                      rule.trigger === "feed_error"
                                        ? "bg-amber-500/10 text-amber-600"
                                        : "bg-primary/10 text-foreground",
                                    )}
                                  >
                                    {rule.trigger === "feed_error" ? t("rules.onFeedError") : t("rules.onArticleMatch")}
                                  </span>
                                  {scopeLabel && (
                                    <span className="text-[10px] px-1.5 py-0.5 rounded-full bg-accent/10 text-foreground">
                                      {scopeLabel}
                                    </span>
                                  )}
                                  {ruleActions.length === 0 ? (
                                    <span className="text-[10px] px-1.5 py-0.5 rounded-full bg-muted text-muted-foreground">—</span>
                                  ) : (
                                    ruleActions.map((a, idx) => (
                                      <span
                                        key={`${rule.id}-act-${idx}-${a}`}
                                        className="text-[10px] px-1.5 py-0.5 rounded-full bg-muted text-muted-foreground"
                                      >
                                        {idx + 1}. {actionLabel(a, catalog, labels, t)}
                                      </span>
                                    ))
                                  )}
                                </div>
                              </div>
                              <div className="flex items-center gap-1">
                                <Button
                                  size="icon"
                                  variant="ghost"
                                  className="w-7 h-7 rounded-lg text-muted-foreground hover:text-foreground"
                                  onClick={() => {
                                    if (isEditing) {
                                      setEditingRuleId(null);
                                      return;
                                    }
                                    setEditingRuleId(rule.id);
                                    setEditRuleName(rule.name);
                                    setEditRuleQuery(rule.query);
                                    setEditRuleActions(ruleActions.length ? ruleActions : ["mark_read"]);
                                    setEditRuleScope(rule.scope || "all");
                                    setEditRuleTrigger((rule.trigger === "feed_error" ? "feed_error" : "article"));
                                    let parsed: WebhookConfigUi[] = [];
                                    try {
                                      const raw = JSON.parse(rule.webhookConfigs || "[]");
                                      if (Array.isArray(raw)) {
                                        parsed = raw
                                          .filter((c) => c && typeof c.url === "string")
                                          .map((c) => ({
                                            url: String(c.url || ""),
                                            method: ["POST", "GET", "PUT", "PATCH", "DELETE"].includes(c.method) ? c.method : "POST",
                                            headers: c.headers ?? undefined,
                                            bodyTemplate: typeof c.bodyTemplate === "string" ? c.bodyTemplate : undefined,
                                            secret: typeof c.secret === "string" ? c.secret : undefined,
                                          }));
                                      }
                                    } catch {}
                                    setEditRuleWebhooks(parsed);
                                    setEditRuleRemoveSpoilerOnDelete(rule.removeSpoilerOnDelete || false);
                                  }}
                                  title={isEditing ? t("rules.closeEditor") : t("rules.editRule")}
                                >
                                  {isEditing ? <X className="size-4" /> : <Pencil className="size-4" />}
                                </Button>
                                <Button
                                  size="icon"
                                  variant="ghost"
                                  className="w-7 h-7 rounded-lg text-destructive/70 hover:text-destructive hover:bg-destructive/10"
                                  onClick={() =>
                                    setPendingDelete({
                                      type: "auto-read-rule",
                                      id: rule.id,
                                      name: rule.name,
                                    })
                                  }
                                >
                                  <Trash2 className="size-4" />
                                </Button>
                              </div>
                            </div>

                            {isEditing && (
                              <div className="space-y-3 pt-2 border-t border-border/60">
                                <Input
                                  placeholder={t("rules.ruleNamePlaceholder")}
                                  value={editRuleName}
                                  onChange={(e) => setEditRuleName(e.target.value)}
                                  className="rounded-xl h-10"
                                />
                                <div className="grid gap-2 sm:grid-cols-[120px_1fr]">
                                  <label htmlFor="edit-rule-trigger-select" className="text-xs font-medium text-muted-foreground self-center">{t("rules.trigger")}</label>
                                  <Select
                                    value={editRuleTrigger}
                                    onValueChange={(value) => {
                                      const trigger = value === "feed_error" ? "feed_error" : "article";
                                      setEditRuleTrigger(trigger);
                                      const filtered = catalogForTrigger(catalog, trigger);
                                      const allowed = new Set(filtered.map((i) => i.value));
                                      const survived = editRuleActions.filter(
                                        (a) => allowed.has(a) || a.startsWith("webhook_call:") || a.startsWith("label:") || a.startsWith("remove_label:"),
                                      );
                                      const finalActions =
                                        survived.length === 0
                                          ? trigger === "feed_error"
                                            ? ["notify_inapp"]
                                            : ["mark_read"]
                                          : survived;
                                      const packed = repackWebhooks(finalActions, editRuleWebhooks);
                                      setEditRuleActions(packed.actions);
                                      setEditRuleWebhooks(packed.webhookConfigs);
                                    }}
                                  >
                                    <SelectTrigger id="edit-rule-trigger-select" className="rounded-xl h-10">
                                      <SelectValue />
                                    </SelectTrigger>
                                    <SelectContent>
                                      <SelectItem value="article">{t("rules.articleMatches")}</SelectItem>
                                      <SelectItem value="feed_error">{t("rules.feedFails")}</SelectItem>
                                    </SelectContent>
                                  </Select>
                                </div>
                                {editRuleTrigger === "article" && (
                                  <Input
                                    placeholder={t("rules.queryPlaceholder")}
                                    value={editRuleQuery}
                                    onChange={(e) => setEditRuleQuery(e.target.value)}
                                    className="rounded-xl h-10"
                                  />
                                )}
                                <div className="grid gap-2 sm:grid-cols-[120px_1fr]">
                                  <label htmlFor="edit-rule-scope-select" className="text-xs font-medium text-muted-foreground self-center">{t("rules.scope")}</label>
                                  <Select value={editRuleScope} onValueChange={setEditRuleScope}>
                                    <SelectTrigger id="edit-rule-scope-select" className="rounded-xl h-10">
                                      <SelectValue />
                                    </SelectTrigger>
                                    <SelectContent>
                                      <SelectItem value="all">{editRuleTrigger === "feed_error" ? t("rules.anyFeed") : t("rules.allArticles")}</SelectItem>
                                      {feeds.map((feed) => (
                                        <SelectItem key={`edit-scope-feed-${feed.id}`} value={`feed:${feed.id}`}>{t("rules.feedScope", { name: feed.name })}</SelectItem>
                                      ))}
                                      {categories.map((c) => (
                                        <SelectItem key={`edit-scope-cat-${c.id}`} value={`category:${c.id}`}>{t("rules.categoryScope", { name: c.name })}</SelectItem>
                                      ))}
                                    </SelectContent>
                                  </Select>
                                </div>
                                <div className="space-y-1.5">
                                  <label className="text-xs font-medium text-muted-foreground">
                                    {t("rules.actionsRunInOrder")}
                                    {editRuleTrigger === "feed_error" && (
                                      <span className="ms-2 text-xs font-semibold uppercase tracking-wider text-amber-500">{t("rules.notifyWebhookOnly")}</span>
                                    )}
                                  </label>
                                  <ActionListEditor
                                    value={editRuleActions}
                                    webhookConfigs={editRuleWebhooks}
                                    onChange={({ actions, webhookConfigs }) => {
                                      setEditRuleActions(actions);
                                      setEditRuleWebhooks(webhookConfigs);
                                    }}
                                    catalog={catalogForTrigger(catalog, editRuleTrigger)}
                                    labels={labels}
                                  />
                                  {editRuleActions.includes("mark_spoiler") && (
                                    <label htmlFor="edit-rule-remove-spoiler-checkbox" className="flex items-center gap-2 cursor-pointer select-none mt-1">
                                      <Checkbox
                                        id="edit-rule-remove-spoiler-checkbox"
                                        checked={editRuleRemoveSpoilerOnDelete}
                                        onCheckedChange={(v) => setEditRuleRemoveSpoilerOnDelete(!!v)}
                                      />
                                      <span className="text-xs text-muted-foreground">{t("rules.removeSpoilerOnDeleteLabel")}</span>
                                    </label>
                                  )}
                                </div>
                                <div className="flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
                                  <Button
                                    size="sm"
                                    variant="ghost"
                                    className="rounded-xl"
                                    onClick={() => setEditingRuleId(null)}
                                  >
                                    {t("rules.closeEditor")}
                                  </Button>
                                  <Button
                                    size="sm"
                                    className="rounded-xl"
                                    disabled={
                                      !editRuleName.trim() ||
                                      (editRuleTrigger === "article" && !editRuleQuery.trim()) ||
                                      editRuleActions.length === 0 ||
                                      updateAutoReadRule.isPending
                                    }
                                    onClick={() =>
                                      updateAutoReadRule.mutate(
                                        {
                                          ruleId: rule.id,
                                          data: {
                                            name: editRuleName.trim(),
                                            query: editRuleQuery.trim(),
                                            actions: editRuleActions,
                                            scope: editRuleScope === "all" ? null : editRuleScope,
                                            trigger: editRuleTrigger,
                                            webhookConfigs: editRuleWebhooks,
                                            removeSpoilerOnDelete: editRuleRemoveSpoilerOnDelete,
                                          },
                                        },
                                        { onSuccess: () => setEditingRuleId(null) },
                                      )
                                    }
                                  >
                                    {t("rules.saveChanges")}
                                  </Button>
                                </div>
                              </div>
                            )}
                          </div>
                        );
                      })}
                    </div>
                  )}

                </div>
              </ScrollArea>
            </TabsContent>

            <TabsContent
              value="alerts"
              className="h-full mt-0 focus-visible:outline-none"
            >
              <ScrollArea className="h-full px-6 sm:px-8">
                <div className="space-y-6 py-4 pb-8">
                  <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
                    <div>
                      <h3 className="text-lg font-semibold tracking-tight">{t("alerts.keywordAlerts")}</h3>
                      <p className="text-sm text-muted-foreground mt-0.5">
                        {t("alerts.createInAppNotifications")}
                      </p>
                    </div>
                    <Button size="sm" className="w-full rounded-xl gap-1.5 sm:w-auto" onClick={() => setShowAddAlert(true)}>
                      <Plus className="size-4" />
                      {t("alerts.addAlert")}
                    </Button>
                  </div>

                  {/* text-amber-700 in light mode / dark:text-amber-400 in dark
                      mode: -400 alone has poor contrast on a light background —
                      same fix as the blue tutorial banner above. */}
                  <div className="rounded-2xl border border-amber-500/20 bg-amber-500/5 p-4 space-y-3">
                    <div className="flex items-center gap-2 text-sm font-medium text-amber-700 dark:text-amber-400">
                      <Info className="w-4 h-4 shrink-0" />
                      {t("alerts.howAlertsWork")}
                    </div>
                    <div className="space-y-3 text-xs text-muted-foreground leading-relaxed">
                      <p>{t("alerts.alertsExplanation")}</p>

                      <div>
                        <p className="font-medium text-foreground/80 mb-1.5">Examples</p>
                        <div className="space-y-1.5 font-mono">
                          <div className="flex flex-col gap-0.5">
                            <code className="text-foreground/80">intitle:security intitle:breach</code>
                            <span className="font-sans">→ alert on headlines containing both words</span>
                          </div>
                          <div className="flex flex-col gap-0.5">
                            <code className="text-foreground/80">author:Jane OR author:John</code>
                            <span className="font-sans">→ alert when specific authors publish</span>
                          </div>
                          <div className="flex flex-col gap-0.5">
                            <code className="text-foreground/80">intitle:recall category:Tech</code>
                            <span className="font-sans">→ category-scoped keyword alert</span>
                          </div>
                          <div className="flex flex-col gap-0.5">
                            <code className="text-foreground/80">#watchlist intitle:earnings</code>
                            <span className="font-sans">→ articles tagged #watchlist about earnings</span>
                          </div>
                          <div className="flex flex-col gap-0.5">
                            <code className="text-foreground/80">feed:&quot;The Verge&quot; -intitle:sponsored</code>
                            <span className="font-sans">→ feed-scoped, excluding promotional posts</span>
                          </div>
                        </div>
                      </div>

                      <div>
                        <p className="font-medium text-foreground/80 mb-1.5">Available operators</p>
                        <ul className="grid grid-cols-1 sm:grid-cols-2 gap-x-4 gap-y-1 list-none">
                          <li><code className="bg-background/60 px-1 rounded">intitle:</code> / <code className="bg-background/60 px-1 rounded">title:</code> — match in title</li>
                          <li><code className="bg-background/60 px-1 rounded">intext:</code> / <code className="bg-background/60 px-1 rounded">content:</code> — body / excerpt</li>
                          <li><code className="bg-background/60 px-1 rounded">author:</code> / <code className="bg-background/60 px-1 rounded">by:</code> — author</li>
                          <li><code className="bg-background/60 px-1 rounded">inurl:</code> / <code className="bg-background/60 px-1 rounded">link:</code> — article URL</li>
                          <li><code className="bg-background/60 px-1 rounded">feed:</code> / <code className="bg-background/60 px-1 rounded">f:</code> — feed</li>
                          <li><code className="bg-background/60 px-1 rounded">category:</code> / <code className="bg-background/60 px-1 rounded">cat:</code> — category</li>
                          <li><code className="bg-background/60 px-1 rounded">label:</code> / <code className="bg-background/60 px-1 rounded">#name</code> — label</li>
                          <li><code className="bg-background/60 px-1 rounded">after:</code> / <code className="bg-background/60 px-1 rounded">before:</code> — date filters</li>
                        </ul>
                      </div>

                      <div className="space-y-1">
                        <p><strong className="text-foreground/70">Modifiers</strong></p>
                        <ul className="space-y-0.5">
                          <li>– Multiple terms = AND. Use <code className="bg-background/60 px-1 rounded">OR</code> (uppercase) to allow either match.</li>
                          <li>– Prefix <code className="bg-background/60 px-1 rounded">-</code> or <code className="bg-background/60 px-1 rounded">!</code> to exclude: <code className="bg-background/60 px-1 rounded">-intitle:sponsored</code>.</li>
                          <li>– Quote multi-word values: <code className="bg-background/60 px-1 rounded">intitle:&quot;data breach&quot;</code>.</li>
                          <li>– Plain words search across title, content, author, url and labels.</li>
                          <li>– Tip: keep alert queries narrow — they fire on every new match.</li>
                        </ul>
                      </div>
                    </div>
                  </div>

                  {showAddAlert && (
                    <div className="rounded-2xl border border-border/60 bg-card p-5 space-y-4">
                      <h4 className="font-medium text-sm">{t("alerts.newAlert")}</h4>
                      <div className="grid gap-3">
                        <Input
                          placeholder={t("alerts.alertNamePlaceholder")}
                          value={newAlertName}
                          onChange={(e) => setNewAlertName(e.target.value)}
                          className="rounded-xl h-10"
                        />
                        <div className="flex flex-col gap-2 sm:flex-row">
                          <Input
                            placeholder={t("alerts.queryExamplePlaceholder")}
                            value={newAlertQuery}
                            onChange={(e) => {
                              setNewAlertQuery(e.target.value);
                              setAlertPreview(null);
                            }}
                            className="rounded-xl h-10 flex-1"
                          />
                          <Button
                            size="sm"
                            variant="outline"
                            className="rounded-xl shrink-0 gap-1.5"
                            disabled={!newAlertQuery.trim() || previewKeywordAlert.isPending}
                            onClick={() =>
                              previewKeywordAlert.mutate(
                                { query: newAlertQuery, scope: newAlertScope },
                                { onSuccess: (data) => setAlertPreview(data) },
                              )
                            }
                          >
                            <Eye className="size-4" />
                            {t("rules.preview")}
                          </Button>
                        </div>
                        <Select value={newAlertScope} onValueChange={setNewAlertScope}>
                          <SelectTrigger className="rounded-xl h-10">
                            <SelectValue placeholder={t("rules.scope")} />
                          </SelectTrigger>
                          <SelectContent>
                            <SelectItem value="all">{t("alerts.allFeeds")}</SelectItem>
                            {feeds.map((feed: any) => (
                              <SelectItem key={feed.id} value={`feed:${feed.id}`}>{t("rules.feedScope", { name: feed.name })}</SelectItem>
                            ))}
                            {categories.map((category: any) => (
                              <SelectItem key={category.id} value={`category:${category.id}`}>{t("rules.categoryScope", { name: category.name })}</SelectItem>
                            ))}
                          </SelectContent>
                        </Select>
                        <label className="ui-control-surface flex items-center gap-2 rounded-xl border px-3 py-2 text-sm">
                          <input
                            type="checkbox"
                            checked={newAlertPush}
                            onChange={(e) => setNewAlertPush(e.target.checked)}
                          />
                          {t("alerts.sendBrowserPush")}
                        </label>
                        <label className="ui-control-surface flex items-center gap-2 rounded-xl border px-3 py-2 text-sm">
                          <input
                            type="checkbox"
                            checked={newAlertEmail}
                            onChange={(e) => setNewAlertEmail(e.target.checked)}
                          />
                          {t("alerts.sendEmail")}
                        </label>
                      </div>

                      {alertPreview !== null && (
                        <div className="rounded-xl bg-muted/40 p-3 text-sm">
                          {alertPreview.length === 0 ? (
                            <p className="text-muted-foreground italic">{t("rules.noMatchingArticles")}</p>
                          ) : (
                            <div className="space-y-1">
                              <p className="font-medium text-xs text-muted-foreground uppercase tracking-wide mb-2">
                                {t("rules.matchingArticle", { count: alertPreview.length })}
                              </p>
                              {alertPreview.map((a: any) => (
                                <div key={a.id} className="flex items-center gap-2">
                                  <span className="text-xs text-muted-foreground shrink-0">{a.feedName}</span>
                                  <span className="truncate text-sm">{a.title}</span>
                                </div>
                              ))}
                            </div>
                          )}
                        </div>
                      )}

                      <div className="flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
                        <Button
                          size="sm"
                          variant="ghost"
                          className="rounded-xl"
                          onClick={() => {
                            setShowAddAlert(false);
                            setNewAlertName("");
                            setNewAlertQuery("");
                            setNewAlertScope("all");
                            setNewAlertPush(false);
                            setAlertPreview(null);
                          }}
                        >
                          {t("rules.closeEditor")}
                        </Button>
                        <Button
                          size="sm"
                          className="rounded-xl"
                          disabled={!newAlertName.trim() || !newAlertQuery.trim() || createKeywordAlert.isPending}
                          onClick={() =>
                            createKeywordAlert.mutate(
                              {
                                name: newAlertName.trim(),
                                query: newAlertQuery.trim(),
                                scope: newAlertScope,
                                actions: [
                                  "notify_inapp",
                                  ...(newAlertPush ? ["notify_push"] : []),
                                  ...(newAlertEmail ? ["notify_email"] : []),
                                ],
                              },
                              {
                                onSuccess: () => {
                                  setShowAddAlert(false);
                                  setNewAlertName("");
                                  setNewAlertQuery("");
                                  setNewAlertScope("all");
                                  setNewAlertPush(false);
                                  setNewAlertEmail(false);
                                  setAlertPreview(null);
                                },
                              },
                            )
                          }
                        >
                          {t("alerts.saveAlert")}
                        </Button>
                      </div>
                    </div>
                  )}

                  {keywordAlerts.length === 0 && !showAddAlert ? (
                    <Empty>
                      <EmptyMedia variant="icon"><Bell className="size-5" /></EmptyMedia>
                      <EmptyContent>
                        <EmptyTitle>{t("alerts.noKeywordAlerts")}</EmptyTitle>
                        <EmptyDescription>{t("alerts.createInAppNotifications")}</EmptyDescription>
                      </EmptyContent>
                    </Empty>
                  ) : (
                    <div className="space-y-2">
                      {keywordAlerts.map((alert: any) => {
                        const actions = (() => {
                          try { return JSON.parse(alert.actions || "[]"); } catch { return []; }
                        })();
                        const matchCount = alert._count?.notifications ?? 0;
                        const isEditing = editingAlertId === alert.id;
                        const isHistoryOpen = expandedHistoryId === alert.id;
                        return (
                          <div key={alert.id} className="rounded-2xl border border-border/60 bg-card overflow-hidden">
                            {isEditing ? (
                              <div className="flex flex-col gap-3 px-4 py-3">
                                <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
                                  <div className="col-span-2">
                                    <label htmlFor="edit-alert-name-input" className="text-xs text-muted-foreground mb-1 block">{t("alerts.alertNamePlaceholder")}</label>
                                    <Input
                                      id="edit-alert-name-input"
                                      value={editAlertName}
                                      onChange={(e) => setEditAlertName(e.target.value)}
                                      className="h-8 rounded-xl text-sm"
                                      placeholder={t("alerts.alertNamePlaceholder")}
                                    />
                                  </div>
                                  <div className="col-span-2">
                                    <label htmlFor="edit-alert-query-input" className="text-xs text-muted-foreground mb-1 block">{t("rules.queryPlaceholder")}</label>
                                    <Input
                                      id="edit-alert-query-input"
                                      value={editAlertQuery}
                                      onChange={(e) => setEditAlertQuery(e.target.value)}
                                      className="h-8 rounded-xl text-sm font-mono"
                                      placeholder={t("alerts.queryExamplePlaceholder")}
                                    />
                                  </div>
                                  <div>
                                    <label htmlFor="edit-alert-scope-select" className="text-xs text-muted-foreground mb-1 block">{t("rules.scope")}</label>
                                    <Select value={editAlertScope} onValueChange={setEditAlertScope}>
                                      <SelectTrigger id="edit-alert-scope-select" className="h-8 rounded-xl text-sm">
                                        <SelectValue />
                                      </SelectTrigger>
                                      <SelectContent>
                                        <SelectItem value="all">{t("alerts.allFeeds")}</SelectItem>
                                        {feeds.map((f: any) => (
                                          <SelectItem key={f.id} value={`feed:${f.id}`}>{f.name}</SelectItem>
                                        ))}
                                        {categories.map((c: any) => (
                                          <SelectItem key={c.id} value={`category:${c.id}`}>{c.name}</SelectItem>
                                        ))}
                                      </SelectContent>
                                    </Select>
                                  </div>
                                  <div className="flex flex-col gap-1.5 justify-end">
                                    <label className="flex items-center gap-2 text-xs text-muted-foreground cursor-pointer">
                                      <input
                                        type="checkbox"
                                        checked={editAlertPush}
                                        onChange={(e) => setEditAlertPush(e.target.checked)}
                                        className="rounded"
                                      />
                                      {t("alerts.pushNotification")}
                                    </label>
                                    <label className="flex items-center gap-2 text-xs text-muted-foreground cursor-pointer">
                                      <input
                                        type="checkbox"
                                        checked={editAlertEmail}
                                        onChange={(e) => setEditAlertEmail(e.target.checked)}
                                        className="rounded"
                                      />
                                      {t("alerts.email")}
                                    </label>
                                  </div>
                                </div>
                                <div className="flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
                                  <Button
                                    size="sm"
                                    variant="ghost"
                                    className="h-7 rounded-xl text-xs"
                                    onClick={() => setEditingAlertId(null)}
                                  >
                                    {t("rules.closeEditor")}
                                  </Button>
                                  <Button
                                    size="sm"
                                    className="h-7 rounded-xl text-xs"
                                    disabled={!editAlertName.trim() || !editAlertQuery.trim() || updateKeywordAlert.isPending}
                                    onClick={() =>
                                      updateKeywordAlert.mutate(
                                        {
                                          alertId: alert.id,
                                          data: {
                                            name: editAlertName.trim(),
                                            query: editAlertQuery.trim(),
                                            scope: editAlertScope,
                                            actions: [
                                              "notify_inapp",
                                              ...(editAlertPush ? ["notify_push"] : []),
                                              ...(editAlertEmail ? ["notify_email"] : []),
                                            ],
                                          },
                                        },
                                        { onSuccess: () => setEditingAlertId(null) },
                                      )
                                    }
                                  >
                                    {t("alerts.saveAlert")}
                                  </Button>
                                </div>
                              </div>
                            ) : (
                              <div className="flex flex-col gap-3 px-4 py-3 sm:flex-row sm:items-center">
                                <div className="flex min-w-0 flex-1 items-start gap-3">
                                  <button
                                    onClick={() =>
                                      updateKeywordAlert.mutate({
                                        alertId: alert.id,
                                        data: { enabled: !alert.enabled },
                                      })
                                    }
                                    className={cn(
                                      "shrink-0 rounded-lg p-1.5 transition-colors",
                                      alert.enabled ? "bg-primary text-primary-foreground" : "text-muted-foreground/50 bg-muted",
                                    )}
                                    title={alert.enabled ? t("alerts.disableAlert") : t("alerts.enableAlert")}
                                  >
                                    <Power className="size-4" />
                                  </button>
                                  <Bell className="mt-1 h-4 w-4 shrink-0 text-muted-foreground" />
                                  <div className="min-w-0 flex-1">
                                  <div className="flex min-w-0 items-center gap-2">
                                    <p className="font-medium text-sm truncate">{alert.name}</p>
                                    {matchCount > 0 && (
                                      <span className="shrink-0 rounded-full bg-primary/10 text-foreground text-[10px] font-medium px-1.5 py-0.5">
                                        {t("alerts.matchCount", { count: matchCount })}
                                      </span>
                                    )}
                                  </div>
                                  <p className="text-xs text-muted-foreground font-mono truncate">{alert.query}</p>
                                  <p className="text-xs text-muted-foreground truncate">
                                    {t("alerts.scopeSummary", {
                                      scope: alert.scope === "all" ? t("alerts.allFeeds") : alert.scope,
                                      channels: [
                                        t("alerts.channelInApp"),
                                        ...(actions.includes("notify_push") ? [t("alerts.channelPush")] : []),
                                        ...(actions.includes("notify_email") ? [t("alerts.channelEmail")] : []),
                                      ].join(" + "),
                                    })}
                                    {alert.lastTriggeredAt ? ` · ${t("alerts.lastTriggered", { date: format.dateTime(new Date(alert.lastTriggeredAt), { dateStyle: "medium", timeStyle: "short" }) })}` : ""}
                                  </p>
                                  </div>
                                </div>
                                <div className="flex flex-wrap justify-end gap-1">
                                <Button
                                  size="icon"
                                  variant="ghost"
                                  className="w-7 h-7 rounded-lg text-muted-foreground hover:text-foreground"
                                  title={t("alerts.recentMatches")}
                                  onClick={() => setExpandedHistoryId(isHistoryOpen ? null : alert.id)}
                                >
                                  <History className="size-4" />
                                </Button>
                                <Button
                                  size="icon"
                                  variant="ghost"
                                  className="w-7 h-7 rounded-lg text-muted-foreground hover:text-foreground"
                                  title={t("alerts.editAlert")}
                                  onClick={() => {
                                    setEditingAlertId(alert.id);
                                    setEditAlertName(alert.name);
                                    setEditAlertQuery(alert.query);
                                    setEditAlertScope(alert.scope);
                                    setEditAlertPush(actions.includes("notify_push"));
                                    setEditAlertEmail(actions.includes("notify_email"));
                                  }}
                                >
                                  <Pencil className="size-4" />
                                </Button>
                                <Button
                                  size="sm"
                                  variant="outline"
                                  className="h-8 rounded-xl"
                                  onClick={() => testKeywordAlert.mutate(alert.id)}
                                  disabled={testKeywordAlert.isPending}
                                >
                                  {t("alerts.testAlert")}
                                </Button>
                                <Button
                                  size="icon"
                                  variant="ghost"
                                  className="w-7 h-7 rounded-lg text-destructive/70 hover:text-destructive hover:bg-destructive/10"
                                  onClick={() => setPendingDelete({ type: "keyword-alert", id: alert.id, name: alert.name })}
                                >
                                  <Trash2 className="size-4" />
                                </Button>
                                </div>
                              </div>
                            )}
                            {isHistoryOpen && (
                              <div className="border-t border-border/60 px-4 py-3 bg-muted/30">
                                <p className="text-xs font-medium text-muted-foreground mb-2">{t("alerts.recentMatches")}</p>
                                {historyLoading ? (
                                  <p className="text-xs text-muted-foreground">{tc("loading")}…</p>
                                ) : alertHistory.length === 0 ? (
                                  <p className="text-xs text-muted-foreground">{t("alerts.noMatches")}</p>
                                ) : (
                                  <div className="space-y-1.5 max-h-48 overflow-y-auto">
                                    {alertHistory.map((n: any) => (
                                      <button
                                        key={n.id}
                                        className={cn(
                                          "w-full text-start rounded-lg px-2.5 py-1.5 text-xs transition-colors",
                                          n.read ? "text-muted-foreground" : "text-foreground font-medium bg-primary/5",
                                        )}
                                        onClick={() => {
                                          if (!n.read) markNotificationRead.mutate(n.id);
                                        }}
                                      >
                                        <span className="block truncate">{n.body}</span>
                                        <span className="text-xs text-muted-foreground">
                                          {format.dateTime(new Date(n.createdAt), { dateStyle: "medium", timeStyle: "short" })}
                                        </span>
                                      </button>
                                    ))}
                                  </div>
                                )}
                              </div>
                            )}
                          </div>
                        );
                      })}
                    </div>
                  )}
                </div>
              </ScrollArea>
            </TabsContent>
          </div>
        <FeedEditDialog
          feed={editingFeed}
          open={!!editingFeed}
          onOpenChange={(open) => { if (!open) setEditingFeed(null); }}
        />

        <AlertDialog
          open={!!pendingDelete}
          onOpenChange={(nextOpen) => {
            if (!nextOpen) setPendingDelete(null);
          }}
        >
          <AlertDialogContent className="rounded-3xl border-border/70 bg-background">
            <AlertDialogHeader>
              <AlertDialogTitle>
                {pendingDelete?.type === "feed"
                  ? t("deleteConfirm.titleFeed")
                  : pendingDelete?.type === "category"
                    ? t("deleteConfirm.titleCategory")
                    : pendingDelete?.type === "label"
                      ? t("deleteConfirm.titleLabel")
                      : pendingDelete?.type === "auto-read-rule"
                        ? t("deleteConfirm.titleRule")
                        : pendingDelete?.type === "keyword-alert"
                          ? t("deleteConfirm.titleAlert")
                        : t("deleteConfirm.titleSavedSearch")}
              </AlertDialogTitle>
              <AlertDialogDescription>
                {t("deleteConfirm.description", { name: pendingDelete?.name ?? "" })}
              </AlertDialogDescription>
            </AlertDialogHeader>
            <AlertDialogFooter>
              <AlertDialogCancel className="rounded-2xl">{tc("cancel")}</AlertDialogCancel>
              <AlertDialogAction
                className="rounded-2xl bg-destructive text-destructive-foreground hover:bg-destructive/90"
                onClick={() => {
                  if (!pendingDelete) return;
                  if (pendingDelete.type === "feed") {
                    deleteFeed.mutate(pendingDelete.id);
                  } else if (pendingDelete.type === "category") {
                    deleteCategory.mutate(pendingDelete.id);
                  } else if (pendingDelete.type === "label") {
                    deleteLabel.mutate(pendingDelete.id);
                  } else if (pendingDelete.type === "auto-read-rule") {
                    deleteAutoReadRule.mutate(pendingDelete.id);
                  } else if (pendingDelete.type === "keyword-alert") {
                    deleteKeywordAlert.mutate(pendingDelete.id);
                  } else {
                    deleteSavedSearch.mutate(pendingDelete.id);
                  }
                  setPendingDelete(null);
                }}
              >
                {tc("delete")}
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

// ─────────────────────────────────────────────────────────────────────────────
// Migration wizard

type MigrationSource = {
  id: string;
  name: string;
  steps: string[];
  endpointHint?: string;
  docsUrl?: string;
};

const MIGRATION_SOURCES: MigrationSource[] = [
  {
    id: "feedly",
    name: "Feedly",
    docsUrl: "https://feedly.com/i/opml",
    steps: [
      "Sign in to feedly.com on the web.",
      "Open https://feedly.com/i/opml to download feedly.opml directly.",
      "Or: ☰ Menu → Organize Sources → Export OPML.",
      "Pick the downloaded .opml file in the next step.",
    ],
  },
  {
    id: "inoreader",
    name: "Inoreader",
    docsUrl: "https://www.inoreader.com/preferences",
    steps: [
      "Open Inoreader → Preferences (gear icon) → Import / Export.",
      "Click \"Export your subscriptions as OPML file\" and save it.",
      "Pick that .opml file in the next step.",
    ],
  },
  {
    id: "freshrss",
    name: "FreshRSS",
    endpointHint: "https://your-freshrss.example.com/i/?c=importExport",
    steps: [
      "Open your FreshRSS instance → ⚙ → Import / Export.",
      "Click \"Export\" and choose OPML (subscriptions only).",
      "Optionally: append `?c=importExport&a=opmlExport` directly to your FreshRSS URL.",
      "Upload the downloaded .opml file below.",
    ],
  },
  {
    id: "newsblur",
    name: "NewsBlur",
    docsUrl: "https://www.newsblur.com/?next=/import",
    steps: [
      "Sign in to newsblur.com.",
      "Settings (gear) → Account → Manage → Export OPML.",
      "Upload the downloaded file in the next step.",
    ],
  },
  {
    id: "the-old-reader",
    name: "The Old Reader",
    docsUrl: "https://theoldreader.com/profile/settings",
    steps: [
      "Open The Old Reader → Settings → Import/Export.",
      "Click \"Download subscriptions as OPML\".",
      "Upload the file in the next step.",
    ],
  },
  {
    id: "reeder",
    name: "Reeder",
    steps: [
      "Open Reeder → Preferences → Accounts (or Manage Subscriptions).",
      "Use \"Share OPML…\" or \"Export OPML…\" depending on your version.",
      "Send the .opml to this device, then upload it below.",
    ],
  },
  {
    id: "netnewswire",
    name: "NetNewsWire",
    steps: [
      "Open NetNewsWire → File → Export Subscriptions… (or the menu equivalent on iOS).",
      "Save the .opml file.",
      "Upload it in the next step.",
    ],
  },
  {
    id: "google-reader",
    name: "Other Google Reader-style readers",
    steps: [
      "Find the OPML/Subscriptions export option in your reader. Most Google Reader-compatible apps support it.",
      "Tiny Tiny RSS: Preferences → Feeds → OPML → Export OPML.",
      "Miniflux: Settings → Integrations → Export feeds as OPML.",
      "Upload the resulting .opml in the next step.",
    ],
  },
  {
    id: "generic",
    name: "Other / I already have an OPML file",
    steps: [
      "If your reader can export OPML, drop the file in the next step.",
      "Most readers list this option under Settings → Import/Export, Subscriptions, or Account.",
    ],
  },
];

function MigrationWizard({
  onUpload,
  isImporting,
}: {
  onUpload: (e: React.ChangeEvent<HTMLInputElement>) => void;
  isImporting: boolean;
}) {
  const t = useTranslations("feedManagement");
  const [step, setStep] = useState<"source" | "instructions" | "upload">("source");
  const [selected, setSelected] = useState<MigrationSource | null>(null);

  return (
    <div className="space-y-4 rounded-3xl border border-primary/20 bg-primary/[0.04] p-7 shadow-sm">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div className="flex items-center gap-3 text-xl font-semibold tracking-[-0.02em] text-primary">
          <Compass className="w-6 h-6" />
          {t("migration.migrationWizard")}
        </div>
        <ol className="flex items-center gap-1 text-xs font-semibold uppercase tracking-wider text-muted-foreground">
          {(["source", "instructions", "upload"] as const).map((s, i) => (
            <li key={s} className="flex items-center gap-1">
              <span
                className={cn(
                  "inline-flex h-5 w-5 items-center justify-center rounded-full border",
                  s === step
                    ? "border-primary bg-primary text-primary-foreground"
                    : step === "upload" || (step === "instructions" && i < 2)
                      ? "border-primary/60 text-foreground"
                      : "border-border text-muted-foreground",
                )}
              >
                {i + 1}
              </span>
              <span className="hidden sm:inline">{s === "source" ? t("migration.source") : s === "instructions" ? t("migration.export") : t("migration.upload")}</span>
              {i < 2 && <span className="text-muted-foreground/50">›</span>}
            </li>
          ))}
        </ol>
      </div>

      {step === "source" && (
        <div className="space-y-3">
          <p className="text-sm text-muted-foreground">
            {t("migration.pickReader")}
          </p>
          <div className="grid gap-2 sm:grid-cols-2">
            {MIGRATION_SOURCES.map((src) => (
              <button
                key={src.id}
                type="button"
                onClick={() => {
                  setSelected(src);
                  setStep("instructions");
                }}
                className="flex items-center justify-between gap-3 rounded-2xl border border-border/60 bg-background/70 px-4 py-3 text-start text-sm font-medium hover:border-primary/40 hover:bg-primary/5 transition-colors active:scale-[0.99]"
              >
                <span>{src.name}</span>
                <ChevronRight className="h-4 w-4 text-muted-foreground rtl:rotate-180" />
              </button>
            ))}
          </div>
        </div>
      )}

      {step === "instructions" && selected && (
        <div className="space-y-4">
          <div className="flex items-center justify-between">
            <p className="text-sm font-semibold">{selected.name} → FeedFerret</p>
            <button
              type="button"
              onClick={() => setStep("source")}
              className="text-xs text-muted-foreground hover:text-foreground inline-flex items-center gap-1"
            >
              <ArrowUp className="h-3 w-3 rotate-[-90deg]" /> {t("migration.changeSource")}
            </button>
          </div>
          <ol className="space-y-2 text-sm text-muted-foreground leading-relaxed list-decimal list-inside">
            {selected.steps.map((s, i) => (
              <li key={i}>{s}</li>
            ))}
          </ol>
          {selected.endpointHint && (
            <div className="rounded-2xl border border-border/60 bg-background/70 px-3 py-2 text-xs font-mono break-all">
              {selected.endpointHint}
            </div>
          )}
          <div className="flex flex-col gap-2 sm:flex-row sm:justify-end">
            {selected.docsUrl && (
              <a
                href={selected.docsUrl}
                target="_blank"
                rel="noopener noreferrer"
                className="order-2 sm:order-1 inline-flex items-center justify-center gap-1.5 rounded-2xl border border-border/60 bg-background px-4 py-2 text-sm font-medium hover:bg-muted/60 transition-colors"
              >
                {t("migration.openSource")} <ChevronRight className="size-4" />
              </a>
            )}
            <button
              type="button"
              onClick={() => setStep("upload")}
              className="order-1 sm:order-2 rounded-2xl bg-primary px-5 py-2 text-sm font-semibold text-primary-foreground shadow-sm hover:bg-primary/90 active:scale-[0.98] transition-all"
            >
              {t("migration.iHaveTheFile")} →
            </button>
          </div>
        </div>
      )}

      {step === "upload" && selected && (
        <div className="space-y-4">
          <div className="flex items-center justify-between">
            <p className="text-sm font-semibold">{t("migration.uploadYourOpml")} — {selected.name}</p>
            <button
              type="button"
              onClick={() => setStep("instructions")}
              className="text-xs text-muted-foreground hover:text-foreground"
            >
              ← {t("migration.backToInstructions")}
            </button>
          </div>
          <p className="text-sm text-muted-foreground">
            {t("migration.standardOpml")}
          </p>
          <Label htmlFor="migration-opml-upload" className="block">
            <div className="inline-flex h-12 cursor-pointer items-center justify-center gap-2 rounded-2xl bg-primary px-8 text-sm font-medium text-primary-foreground shadow-sm transition-all hover:bg-primary/90 active:scale-95">
              <Upload className="w-4 h-4" />
              {isImporting ? t("migration.importing") : t("migration.chooseOpmlFile")}
            </div>
            <Input
              id="migration-opml-upload"
              type="file"
              accept=".xml,.opml"
              className="hidden"
              disabled={isImporting}
              onChange={onUpload}
            />
          </Label>
        </div>
      )}
    </div>
  );
}
