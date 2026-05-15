"use client";

import { useEffect, useState, useMemo } from "react";
import { useSearchParams } from "next/navigation";
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
  useWebhooks,
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
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { TabsContent } from "@/components/ui/tabs";
import { SettingsModalShell, SettingsPageShell } from "@/components/settings-shell";
import { ScrollArea } from "@/components/ui/scroll-area";
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

function SortableCategoryItem({
  cat,
  editingCategoryId,
  editingCategoryName,
  setEditingCategoryName,
  setEditingCategoryId,
  updateCategory,
  requestDelete,
}: any) {
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
      className="rounded-3xl border border-border/60 bg-card p-4 shadow-sm transition-all hover:border-border"
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
              <span className="text-[10px] text-muted-foreground uppercase font-bold tracking-widest">
                Sync: {cat.updateFrequency ? `${cat.updateFrequency} min` : "Global Default"}
              </span>
            </div>
            {/* Always-visible action buttons (#17) */}
            <div className="flex flex-wrap items-center justify-end gap-1">
              <Button
                size="icon"
                variant="ghost"
                className="h-9 w-9 rounded-xl text-muted-foreground hover:text-foreground"
                title="Category settings"
                onClick={() => { setSyncValue(cat.updateFrequency ? String(cat.updateFrequency) : ""); setSettingsOpen(true); }}
              >
                <Settings2 className="w-4 h-4" />
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
    {settingsOpen && (
      <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 backdrop-blur-sm" onClick={() => setSettingsOpen(false)}>
        <div className="w-full max-w-sm rounded-3xl border border-border/70 bg-background p-6 shadow-2xl space-y-4" onClick={(e) => e.stopPropagation()}>
          <div className="flex items-center gap-3">
            <Folder className="w-5 h-5 text-primary" />
            <h3 className="font-semibold tracking-tight">Category Settings — {cat.name}</h3>
          </div>
          <div className="space-y-1.5">
            <label className="text-sm font-medium">Sync interval (minutes)</label>
            <p className="text-xs text-muted-foreground">Leave empty to use the global default.</p>
            <Input
              type="number"
              placeholder="e.g. 60"
              value={syncValue}
              onChange={(e) => setSyncValue(e.target.value)}
              className="h-10 rounded-2xl border-border/70 bg-background/70"
            />
          </div>
          <div className="flex justify-end gap-2 pt-2">
            <Button variant="ghost" className="rounded-2xl" onClick={() => setSettingsOpen(false)}>Cancel</Button>
            <Button className="rounded-2xl" onClick={() => {
              const val = parseInt(syncValue);
              updateCategory.mutate({ categoryId: cat.id, data: { updateFrequency: isNaN(val) ? null : val } });
              setSettingsOpen(false);
            }}>Save</Button>
          </div>
        </div>
      </div>
    )}
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
  const { data: autoReadRules = [] } = useAutoReadRules();
  const createAutoReadRule = useCreateAutoReadRule();
  const updateAutoReadRule = useUpdateAutoReadRule();
  const deleteAutoReadRule = useDeleteAutoReadRule();
  const applyAutoReadRulesNow = useApplyAutoReadRulesNow();
  const previewAutoReadRule = usePreviewAutoReadRule();
  const { data: keywordAlerts = [] } = useKeywordAlerts();
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
    (feeds as any[]).forEach((feed) => {
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
  const [rulePreview, setRulePreview] = useState<any[] | null>(null);
  const [showAddRule, setShowAddRule] = useState(false);
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
  const { data: webhooks = [] } = useWebhooks();
  const { data: savedSearches = [] } = useSavedSearches();

  useEffect(() => {
    if (open) setActiveTab(normalizeInitialTab(initialTab));
  }, [initialTab, open]);

  // Initialize all categories as expanded when categories load
  useEffect(() => {
    if (categories.length > 0) {
      setExpandedCategories(new Set([...categories.map((c: any) => c.id), "__uncategorized__"]));
    }
  }, [categories.length]); // eslint-disable-line react-hooks/exhaustive-deps

  const searchParams = useSearchParams();
  const highlightFeedId = searchParams.get("feedId");

  useEffect(() => {
    if (!highlightFeedId || feeds.length === 0) return;
    setActiveTab("feeds");
    const feed = (feeds as any[]).find((f) => f.id === highlightFeedId);
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
          toast.success(`Import complete: ${report.feedsAdded} added, ${report.feedsUpdated} updated`);
        },
        onError: () => toast.error("Failed to import feeds"),
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
        toast.success(ids ? `${ids.length} feeds exported` : "All feeds exported");
      },
      onError: () => toast.error("Failed to export feeds"),
    });
  };

  const handleAddCategory = () => {
    if (!newCategoryName.trim()) return;
    addCategory.mutate(
      { name: newCategoryName },
      {
        onSuccess: () => {
          setNewCategoryName("");
          toast.success("Category added");
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
          toast.success("Label added");
        },
        onError: (error) => {
          toast.error(error instanceof Error ? error.message : "Failed to add label");
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
        toast.success(`Moved ${activeCategory.name} into ${overCategory.name}`);
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
    { value: "feeds", label: "Feeds" },
    { value: "categories", label: "Categories" },
    { value: "opml", label: "Import/Export" },
    { value: "labels", label: "Labels & Searches" },
    { value: "health", label: "Health" },
    { value: "rules", label: "Rules" },
    { value: "alerts", label: "Alerts" },
  ];

  const shellProps = { title: "Manage Feeds", description: "Organize your feeds, categories, and data.", activeTab, onTabChange: setActiveTab, tabs: shellTabs };

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
                      ? [{ id: "__uncategorized__", name: "Uncategorized", feeds: feedsByCategory.uncategorized }]
                      : []),
                  ].map(({ id: groupId, name: groupName, feeds: groupFeeds }) => {
                    const expanded = expandedCategories.has(groupId);
                    return (
                      <div key={groupId}>
                        <button
                          type="button"
                          onClick={() => toggleCategory(groupId)}
                          className="flex w-full items-center gap-2 py-1.5 text-left text-sm font-semibold text-muted-foreground hover:text-foreground transition-colors"
                        >
                          <ChevronRight className={cn("w-4 h-4 transition-transform duration-200", expanded && "rotate-90")} />
                          <Folder className="w-3.5 h-3.5 text-primary" />
                          {groupName}
                          <span className="text-xs font-normal text-muted-foreground/60">({groupFeeds.length})</span>
                        </button>
                        {expanded && (
                          <div className="mt-1.5 space-y-2 pl-6 border-l-2 border-border/40">
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
                                    <div className="mt-0.5 flex flex-wrap gap-2 text-[10px] text-muted-foreground">
                                      <span>
                                        Last sync:{" "}
                                        {feed.lastFetchedAt
                                          ? new Date(feed.lastFetchedAt).toLocaleString()
                                          : "never"}
                                      </span>
                                      {feed.lastStatus === "error" && (
                                        <span className="text-destructive" title={feed.lastError || undefined}>
                                          Sync error
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
                                    <SelectTrigger className="h-8 w-full rounded-xl border-border/70 bg-background/70 shadow-sm text-xs sm:w-32">
                                      <SelectValue placeholder="Category" />
                                    </SelectTrigger>
                                    <SelectContent className="rounded-2xl border-border/70 shadow-xl">
                                      <SelectItem value="none">No Category</SelectItem>
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
                                      className="h-8 shrink-0 rounded-xl px-2.5 text-muted-foreground transition-all hover:bg-accent"
                                      title="Feed settings"
                                      onClick={() => setEditingFeed(feed)}
                                    >
                                      <Settings2 className="w-4 h-4" />
                                      <span className="ml-1.5 hidden lg:inline text-xs">Settings</span>
                                    </Button>
                                    <Button
                                      variant="ghost"
                                      size="sm"
                                      className="h-8 shrink-0 rounded-xl px-2.5 text-muted-foreground transition-all hover:bg-destructive/10 hover:text-destructive"
                                      onClick={() =>
                                        setPendingDelete({ type: "feed", id: feed.id, name: feed.name })
                                      }
                                    >
                                      <Trash2 className="w-4 h-4" />
                                      <span className="ml-1.5 hidden lg:inline text-xs">Delete</span>
                                    </Button>
                                  </div>
                                </div>
                              </div>
                            ))}
                            {groupFeeds.length === 0 && (
                              <p className="py-2 text-xs text-muted-foreground italic">No feeds in this category.</p>
                            )}
                          </div>
                        )}
                      </div>
                    );
                  })}
                  {feeds.length === 0 && (
                    <p className="py-10 text-center text-muted-foreground italic">No feeds yet.</p>
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
                    placeholder="New category name..."
                    value={newCategoryName}
                    onChange={(e) => setNewCategoryName(e.target.value)}
                    className="h-11 rounded-2xl border-border/70 bg-card focus-visible:ring-primary"
                  />
                  <Button
                    onClick={handleAddCategory}
                    className="h-11 rounded-2xl bg-primary px-6 transition-all hover:bg-primary/90 active:scale-95"
                  >
                    <FolderPlus className="w-4 h-4 mr-2" />
                    Add
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
                          <p className="text-center py-10 text-muted-foreground italic">
                            No categories yet. Create one above.
                          </p>
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
                <section className="min-h-0 rounded-3xl border border-border/60 bg-card p-5 shadow-sm">
                  <div className="mb-5 flex items-center gap-3">
                    <Tag className="h-5 w-5 text-primary" />
                    <div>
                      <h3 className="font-semibold tracking-[-0.02em]">Labels</h3>
                      <p className="text-sm text-muted-foreground">Tag articles for reusable filters.</p>
                    </div>
                  </div>
                  <div className="mb-5 flex gap-2">
                    <Input
                      placeholder="New label..."
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
                      Add
                    </Button>
                  </div>
                  <ScrollArea className="h-[48vh]">
                    <div className="space-y-2 pr-3">
                      {labels.map((label: any) => (
                        <div
                          key={label.id}
                          className="flex items-center gap-3 rounded-2xl border border-border/60 bg-background/60 p-3"
                        >
                          <span className="h-3 w-3 rounded-full" style={{ backgroundColor: label.color }} />
                          <span className="flex-1 truncate text-sm font-medium">{label.name}</span>
                          <span className="text-xs text-muted-foreground">{label._count?.articles || 0}</span>
                          <Button
                            variant="ghost"
                            size="icon"
                            className="h-8 w-8 rounded-xl text-muted-foreground hover:bg-destructive/10 hover:text-destructive"
                            onClick={() => setPendingDelete({ type: "label", id: label.id, name: label.name })}
                          >
                            <Trash2 className="h-4 w-4" />
                          </Button>
                        </div>
                      ))}
                      {labels.length === 0 && (
                        <p className="py-10 text-center text-sm text-muted-foreground">No labels yet.</p>
                      )}
                    </div>
                  </ScrollArea>
                </section>

                <section className="min-h-0 rounded-3xl border border-border/60 bg-card p-5 shadow-sm">
                  <div className="mb-5 flex items-center gap-3">
                    <Bookmark className="h-5 w-5 text-primary" />
                    <div>
                      <h3 className="font-semibold tracking-[-0.02em]">Saved Searches</h3>
                      <p className="text-sm text-muted-foreground">Advanced queries pinned to the sidebar.</p>
                    </div>
                  </div>
                  <ScrollArea className="h-[56vh]">
                    <div className="space-y-2 pr-3">
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
                          className="rounded-2xl border border-border/60 bg-background/60 p-3"
                        >
                          <div className="flex items-center gap-3">
                            <span className="flex-1 truncate text-sm font-medium">{search.name}</span>
                            <Button
                              variant="ghost"
                              size="icon"
                              className="h-8 w-8 rounded-xl text-muted-foreground hover:bg-accent/10 hover:text-accent"
                              onClick={() => setSavedSearchSharing.mutate({ searchId: search.id, enabled: !search.shareToken })}
                              title={search.shareToken ? "Disable sharing" : "Enable sharing"}
                            >
                              {search.shareToken ? <LinkIcon className="h-4 w-4" /> : <Share2 className="h-4 w-4" />}
                            </Button>
                            <Button
                              variant="ghost"
                              size="icon"
                              className="h-8 w-8 rounded-xl text-muted-foreground hover:bg-destructive/10 hover:text-destructive"
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
                                <LinkIcon className="h-3.5 w-3.5" />
                                Shared read-only link
                              </div>
                              <div className="flex flex-wrap gap-1.5">
                                <Button
                                  variant="outline"
                                  size="sm"
                                  className="h-8 rounded-xl"
                                  onClick={() => { navigator.clipboard.writeText(shareUrl); toast.success("Share link copied"); }}
                                >
                                  <Copy className="mr-1.5 h-3.5 w-3.5" />
                                  Copy
                                </Button>
                                <Button asChild variant="outline" size="sm" className="h-8 rounded-xl">
                                  <a href={shareUrl} target="_blank" rel="noreferrer">
                                    <ExternalLink className="mr-1.5 h-3.5 w-3.5" />
                                    Open
                                  </a>
                                </Button>
                                <Button asChild variant="outline" size="sm" className="h-8 rounded-xl">
                                  <a href={rssUrl} target="_blank" rel="noreferrer">
                                    <Rss className="mr-1.5 h-3.5 w-3.5" />
                                    RSS
                                  </a>
                                </Button>
                              </div>
                            </div>
                          )}
                        </div>
                      )})}
                      {savedSearches.length === 0 && (
                        <p className="py-10 text-center text-sm text-muted-foreground">
                          Use the article search menu to save a query.
                        </p>
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
                <div className="mb-5 flex flex-col gap-4 rounded-3xl border border-border/60 bg-card p-5 shadow-sm sm:flex-row sm:items-center sm:justify-between">
                  <div className="flex items-center gap-3">
                    <Activity className="h-5 w-5 text-primary" />
                    <div>
                      <h3 className="font-semibold tracking-[-0.02em]">Feed Health Dashboard</h3>
                      <p className="text-sm text-muted-foreground">Sync status, errors, article counts and retention.</p>
                    </div>
                  </div>
                  <div className="flex w-full flex-col gap-2 sm:w-auto sm:flex-row sm:items-center">
                    <Button
                      variant="outline"
                      onClick={() => applyRetention.mutate(true)}
                      disabled={applyRetention.isPending}
                      className="w-full rounded-2xl sm:w-auto"
                    >
                      Dry run
                    </Button>
                    <Button
                      onClick={() => applyRetention.mutate(false)}
                      disabled={applyRetention.isPending}
                      className="w-full rounded-2xl sm:w-auto"
                    >
                      <ShieldCheck className="mr-2 h-4 w-4" />
                      Apply retention
                    </Button>
                  </div>
                </div>
                <ScrollArea className="min-h-0 flex-1">
                  <div className="space-y-3 pb-8 pr-3">
                    {feedHealth.map((feed: any) => (
                      <div key={feed.id} className="rounded-3xl border border-border/60 bg-card p-4 shadow-sm">
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
                            </div>
                            <p className="mt-1 truncate text-xs text-muted-foreground">{feed.url}</p>
                            <div className="mt-3 grid grid-cols-1 gap-2 text-xs text-muted-foreground sm:grid-cols-2 lg:grid-cols-5">
                              <span>{feed.articleCount} articles</span>
                              <span>{feed.unreadCount} unread</span>
                              <span>{feed.avgArticlesPerDay != null ? `${feed.avgArticlesPerDay}/day` : "—"}</span>
                              <span>Sync: {feed.lastFetchedAt ? new Date(feed.lastFetchedAt).toLocaleString() : "never"}</span>
                              <span>Retention: {feed.retentionDays || "default"} days</span>
                            </div>
                            {feed.lastError && (
                              <p className="mt-3 rounded-2xl bg-destructive/10 px-3 py-2 text-xs text-destructive">
                                {feed.lastError}
                              </p>
                            )}
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
                <div className="space-y-4 rounded-3xl border border-border/60 bg-card p-7 shadow-sm">
                  <div className="flex items-center gap-3 text-xl font-semibold tracking-[-0.02em] text-primary">
                    <Upload className="w-6 h-6" />
                    Import subscriptions
                  </div>
                  <p className="text-muted-foreground">
                    Upload an OPML file to import all your feeds and categories
                    from another RSS reader.
                  </p>
                  {lastImportReport && (
                    <div className="rounded-2xl border border-border/60 bg-background/70 p-4 text-sm space-y-2">
                      <p className="font-medium">Import result</p>
                      <div className="flex flex-wrap gap-3 text-xs">
                        <span className="rounded-full bg-green-500/10 text-green-600 px-2.5 py-1 font-medium">
                          +{lastImportReport.feedsAdded} new
                        </span>
                        <span className="rounded-full bg-accent/10 text-accent px-2.5 py-1 font-medium">
                          {lastImportReport.feedsUpdated} already existed
                        </span>
                        <span className="rounded-full bg-muted text-muted-foreground px-2.5 py-1 font-medium">
                          {lastImportReport.categoriesAdded} categories
                        </span>
                        {lastImportReport.errors.length > 0 && (
                          <span className="rounded-full bg-destructive/10 text-destructive px-2.5 py-1 font-medium">
                            {lastImportReport.errors.length} errors
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
                      Select OPML File
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

                <div className="space-y-4 rounded-3xl border border-border/60 bg-card p-7 shadow-sm">
                  <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
                    <div className="flex items-center gap-3 text-xl font-semibold tracking-[-0.02em]">
                      <Download className="w-6 h-6 text-muted-foreground" />
                      Export subscriptions
                    </div>
                    <div className="flex gap-2 text-xs">
                      <button
                        className="text-primary hover:underline"
                        onClick={() => setSelectedExportIds(new Set(feeds.map((f: any) => f.id)))}
                      >
                        Select all
                      </button>
                      <span className="text-muted-foreground">·</span>
                      <button
                        className="text-muted-foreground hover:underline"
                        onClick={() => setSelectedExportIds(new Set())}
                      >
                        Deselect all
                      </button>
                    </div>
                  </div>
                  <p className="text-muted-foreground text-sm">
                    Select feeds to export, or leave all unchecked to export everything.
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
                      {selectedExportIds.size > 0 ? `Export ${selectedExportIds.size} feeds` : "Export all feeds"}
                    </Button>
                  </div>
                </div>

                <div className="space-y-4 rounded-3xl border border-border/60 bg-card p-7 shadow-sm">
                  <div className="flex items-center gap-3 text-xl font-semibold tracking-[-0.02em]">
                    <Download className="w-6 h-6 text-muted-foreground" />
                    Export all data (JSON)
                  </div>
                  <p className="text-muted-foreground">
                    Download feeds, labels, saved searches, and auto-read rules as JSON.
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
                          toast.success("Data exported");
                        },
                      })
                    }
                  >
                    Export JSON
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
                      <h3 className="text-lg font-semibold tracking-tight">Auto-mark rules</h3>
                      <p className="text-sm text-muted-foreground mt-0.5">
                        Automatically mark, star, or label articles matching a search query on each sync.
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
                        <Play className="w-3.5 h-3.5" />
                        Run now
                      </Button>
                      <Button
                        size="sm"
                        className="w-full rounded-xl gap-1.5 sm:w-auto"
                        onClick={() => setShowAddRule(true)}
                      >
                        <Plus className="w-3.5 h-3.5" />
                        Add rule
                      </Button>
                    </div>
                  </div>

                  <div className="rounded-2xl border border-blue-500/20 bg-blue-500/5 p-4 space-y-3">
                    <div className="flex items-center gap-2 text-sm font-medium text-blue-400">
                      <Info className="w-4 h-4 shrink-0" />
                      How rules work
                    </div>
                    <div className="space-y-3 text-xs text-muted-foreground leading-relaxed">
                      <p>Rules run after each sync and apply actions to all matching articles. Use the same query syntax as search.</p>

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
                  </div>

                  {showAddRule && (
                    <div className="rounded-2xl border border-border/60 bg-card p-5 space-y-4">
                      <h4 className="font-medium text-sm">New rule</h4>
                      <div className="grid gap-3">
                        <Input
                          placeholder="Rule name"
                          value={newRuleName}
                          onChange={(e) => setNewRuleName(e.target.value)}
                          className="rounded-xl h-10"
                        />
                        <div className="flex flex-col gap-2 sm:flex-row">
                          <Input
                            placeholder='Query, e.g. feed:TechCrunch is:unread'
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
                                { query: newRuleQuery },
                                { onSuccess: (data) => setRulePreview(data) },
                              )
                            }
                          >
                            <Eye className="w-3.5 h-3.5" />
                            Preview
                          </Button>
                        </div>
                        <Select value={newRuleAction} onValueChange={setNewRuleAction}>
                          <SelectTrigger className="rounded-xl h-10">
                            <SelectValue placeholder="Action" />
                          </SelectTrigger>
                          <SelectContent>
                            <SelectItem value="mark_read">Mark as read</SelectItem>
                            <SelectItem value="star">Star article</SelectItem>
                            <SelectItem value="read_later">Save to Read Later</SelectItem>
                            <SelectItem value="delete">Delete article</SelectItem>
                            {labels.length > 0 && labels.map((label: any) => (
                              <SelectItem key={`label-${label.id}`} value={`label:${label.id}`}>
                                Attach label · {label.name}
                              </SelectItem>
                            ))}
                            {(webhooks as any[]).filter((w) => w.enabled).map((wh: any) => (
                              <SelectItem key={`webhook-${wh.id}`} value={`webhook:${wh.id}`}>
                                Trigger webhook · {wh.name}
                              </SelectItem>
                            ))}
                          </SelectContent>
                        </Select>
                      </div>

                      {rulePreview !== null && (
                        <div className="rounded-xl bg-muted/40 p-3 text-sm">
                          {rulePreview.length === 0 ? (
                            <p className="text-muted-foreground italic">No matching articles found</p>
                          ) : (
                            <div className="space-y-1">
                              <p className="font-medium text-xs text-muted-foreground uppercase tracking-wide mb-2">
                                {rulePreview.length} matching article{rulePreview.length !== 1 ? "s" : ""}
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
                            setRulePreview(null);
                          }}
                        >
                          Cancel
                        </Button>
                        <Button
                          size="sm"
                          className="rounded-xl"
                          disabled={
                            !newRuleName.trim() ||
                            !newRuleQuery.trim() ||
                            createAutoReadRule.isPending
                          }
                          onClick={() =>
                            createAutoReadRule.mutate(
                              {
                                name: newRuleName.trim(),
                                query: newRuleQuery.trim(),
                                action: newRuleAction,
                              },
                              {
                                onSuccess: () => {
                                  setShowAddRule(false);
                                  setNewRuleName("");
                                  setNewRuleQuery("");
                                  setNewRuleAction("mark_read");
                                  setRulePreview(null);
                                },
                              },
                            )
                          }
                        >
                          Save rule
                        </Button>
                      </div>
                    </div>
                  )}

                  {autoReadRules.length === 0 && !showAddRule ? (
                    <div className="rounded-2xl border border-dashed border-border/60 p-10 text-center">
                      <p className="text-muted-foreground text-sm">No rules yet. Rules run automatically after each sync.</p>
                    </div>
                  ) : (
                    <div className="space-y-2">
                      {autoReadRules.map((rule: any) => (
                        <div
                          key={rule.id}
                          className="flex flex-col gap-3 rounded-2xl border border-border/60 bg-card px-4 py-3 sm:flex-row sm:items-center"
                        >
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
                                ? "text-primary bg-primary/10"
                                : "text-muted-foreground/50 bg-muted",
                            )}
                            title={rule.enabled ? "Disable rule" : "Enable rule"}
                          >
                            <Power className="w-3.5 h-3.5" />
                          </button>
                          <div className="flex-1 min-w-0">
                            <p className="font-medium text-sm truncate">{rule.name}</p>
                            <p className="text-xs text-muted-foreground font-mono truncate">{rule.query}</p>
                          </div>
                          <span className="shrink-0 text-xs px-2 py-0.5 rounded-full bg-muted text-muted-foreground">
                            {(() => {
                              const action = String(rule.action || "");
                              if (action === "mark_read") return "mark read";
                              if (action === "star") return "star";
                              if (action === "read_later") return "read later";
                              if (action === "delete") return "delete";
                              if (action.startsWith("label:")) {
                                const id = action.slice("label:".length);
                                const label = (labels as any[]).find((l) => l.id === id);
                                return label ? `label · ${label.name}` : "label";
                              }
                              if (action.startsWith("webhook:")) {
                                const id = action.slice("webhook:".length);
                                const wh = (webhooks as any[]).find((w) => w.id === id);
                                return wh ? `webhook · ${wh.name}` : "webhook";
                              }
                              return action || "—";
                            })()}
                          </span>
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
                            <Trash2 className="w-3.5 h-3.5" />
                          </Button>
                        </div>
                      ))}
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
                      <h3 className="text-lg font-semibold tracking-tight">Keyword alerts</h3>
                      <p className="text-sm text-muted-foreground mt-0.5">
                        Create in-app notifications when newly synced articles match a search query.
                      </p>
                    </div>
                    <Button size="sm" className="w-full rounded-xl gap-1.5 sm:w-auto" onClick={() => setShowAddAlert(true)}>
                      <Plus className="w-3.5 h-3.5" />
                      Add alert
                    </Button>
                  </div>

                  <div className="rounded-2xl border border-amber-500/20 bg-amber-500/5 p-4 space-y-3">
                    <div className="flex items-center gap-2 text-sm font-medium text-amber-400">
                      <Info className="w-4 h-4 shrink-0" />
                      How alerts work
                    </div>
                    <div className="space-y-3 text-xs text-muted-foreground leading-relaxed">
                      <p>Alerts fire whenever a newly synced article matches your query. You&apos;ll see a notification badge in the app. Scope can be limited to a specific feed or category.</p>

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
                      <h4 className="font-medium text-sm">New alert</h4>
                      <div className="grid gap-3">
                        <Input
                          placeholder="Alert name"
                          value={newAlertName}
                          onChange={(e) => setNewAlertName(e.target.value)}
                          className="rounded-xl h-10"
                        />
                        <div className="flex flex-col gap-2 sm:flex-row">
                          <Input
                            placeholder='Query, e.g. intitle:security author:Jane'
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
                            <Eye className="w-3.5 h-3.5" />
                            Preview
                          </Button>
                        </div>
                        <Select value={newAlertScope} onValueChange={setNewAlertScope}>
                          <SelectTrigger className="rounded-xl h-10">
                            <SelectValue placeholder="Scope" />
                          </SelectTrigger>
                          <SelectContent>
                            <SelectItem value="all">All feeds</SelectItem>
                            {feeds.map((feed: any) => (
                              <SelectItem key={feed.id} value={`feed:${feed.id}`}>Feed: {feed.name}</SelectItem>
                            ))}
                            {categories.map((category: any) => (
                              <SelectItem key={category.id} value={`category:${category.id}`}>Category: {category.name}</SelectItem>
                            ))}
                          </SelectContent>
                        </Select>
                        <label className="flex items-center gap-2 rounded-xl border border-border/60 bg-background/60 px-3 py-2 text-sm">
                          <input
                            type="checkbox"
                            checked={newAlertPush}
                            onChange={(e) => setNewAlertPush(e.target.checked)}
                          />
                          Also send browser push notification when available
                        </label>
                        <label className="flex items-center gap-2 rounded-xl border border-border/60 bg-background/60 px-3 py-2 text-sm">
                          <input
                            type="checkbox"
                            checked={newAlertEmail}
                            onChange={(e) => setNewAlertEmail(e.target.checked)}
                          />
                          Also send email (requires mail configured in admin settings)
                        </label>
                      </div>

                      {alertPreview !== null && (
                        <div className="rounded-xl bg-muted/40 p-3 text-sm">
                          {alertPreview.length === 0 ? (
                            <p className="text-muted-foreground italic">No matching articles found</p>
                          ) : (
                            <div className="space-y-1">
                              <p className="font-medium text-xs text-muted-foreground uppercase tracking-wide mb-2">
                                {alertPreview.length} matching article{alertPreview.length !== 1 ? "s" : ""}
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
                          Cancel
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
                          Save alert
                        </Button>
                      </div>
                    </div>
                  )}

                  {keywordAlerts.length === 0 && !showAddAlert ? (
                    <div className="rounded-2xl border border-dashed border-border/60 p-10 text-center">
                      <p className="text-muted-foreground text-sm">No alerts yet. Alerts run against newly synced articles.</p>
                    </div>
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
                                    <label className="text-xs text-muted-foreground mb-1 block">Name</label>
                                    <Input
                                      value={editAlertName}
                                      onChange={(e) => setEditAlertName(e.target.value)}
                                      className="h-8 rounded-xl text-sm"
                                      placeholder="Alert name"
                                    />
                                  </div>
                                  <div className="col-span-2">
                                    <label className="text-xs text-muted-foreground mb-1 block">Query</label>
                                    <Input
                                      value={editAlertQuery}
                                      onChange={(e) => setEditAlertQuery(e.target.value)}
                                      className="h-8 rounded-xl text-sm font-mono"
                                      placeholder="keyword OR phrase"
                                    />
                                  </div>
                                  <div>
                                    <label className="text-xs text-muted-foreground mb-1 block">Scope</label>
                                    <Select value={editAlertScope} onValueChange={setEditAlertScope}>
                                      <SelectTrigger className="h-8 rounded-xl text-sm">
                                        <SelectValue />
                                      </SelectTrigger>
                                      <SelectContent>
                                        <SelectItem value="all">All feeds</SelectItem>
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
                                      Push notification
                                    </label>
                                    <label className="flex items-center gap-2 text-xs text-muted-foreground cursor-pointer">
                                      <input
                                        type="checkbox"
                                        checked={editAlertEmail}
                                        onChange={(e) => setEditAlertEmail(e.target.checked)}
                                        className="rounded"
                                      />
                                      Email
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
                                    Cancel
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
                                    Save
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
                                      alert.enabled ? "text-primary bg-primary/10" : "text-muted-foreground/50 bg-muted",
                                    )}
                                    title={alert.enabled ? "Disable alert" : "Enable alert"}
                                  >
                                    <Power className="w-3.5 h-3.5" />
                                  </button>
                                  <Bell className="mt-1 h-4 w-4 shrink-0 text-muted-foreground" />
                                  <div className="min-w-0 flex-1">
                                  <div className="flex min-w-0 items-center gap-2">
                                    <p className="font-medium text-sm truncate">{alert.name}</p>
                                    {matchCount > 0 && (
                                      <span className="shrink-0 rounded-full bg-primary/10 text-primary text-[10px] font-medium px-1.5 py-0.5">
                                        {matchCount} match{matchCount !== 1 ? "es" : ""}
                                      </span>
                                    )}
                                  </div>
                                  <p className="text-xs text-muted-foreground font-mono truncate">{alert.query}</p>
                                  <p className="text-[11px] text-muted-foreground truncate">
                                    Scope: {alert.scope === "all" ? "all feeds" : alert.scope} · {
                                      [
                                        "in-app",
                                        ...(actions.includes("notify_push") ? ["push"] : []),
                                        ...(actions.includes("notify_email") ? ["email"] : []),
                                      ].join(" + ")
                                    }
                                    {alert.lastTriggeredAt ? ` · last: ${new Date(alert.lastTriggeredAt).toLocaleString()}` : ""}
                                  </p>
                                  </div>
                                </div>
                                <div className="flex flex-wrap justify-end gap-1">
                                <Button
                                  size="icon"
                                  variant="ghost"
                                  className="w-7 h-7 rounded-lg text-muted-foreground hover:text-foreground"
                                  title="Show match history"
                                  onClick={() => setExpandedHistoryId(isHistoryOpen ? null : alert.id)}
                                >
                                  <History className="w-3.5 h-3.5" />
                                </Button>
                                <Button
                                  size="icon"
                                  variant="ghost"
                                  className="w-7 h-7 rounded-lg text-muted-foreground hover:text-foreground"
                                  title="Edit alert"
                                  onClick={() => {
                                    setEditingAlertId(alert.id);
                                    setEditAlertName(alert.name);
                                    setEditAlertQuery(alert.query);
                                    setEditAlertScope(alert.scope);
                                    setEditAlertPush(actions.includes("notify_push"));
                                    setEditAlertEmail(actions.includes("notify_email"));
                                  }}
                                >
                                  <Pencil className="w-3.5 h-3.5" />
                                </Button>
                                <Button
                                  size="sm"
                                  variant="outline"
                                  className="h-8 rounded-xl"
                                  onClick={() => testKeywordAlert.mutate(alert.id)}
                                  disabled={testKeywordAlert.isPending}
                                >
                                  Test
                                </Button>
                                <Button
                                  size="icon"
                                  variant="ghost"
                                  className="w-7 h-7 rounded-lg text-destructive/70 hover:text-destructive hover:bg-destructive/10"
                                  onClick={() => setPendingDelete({ type: "keyword-alert", id: alert.id, name: alert.name })}
                                >
                                  <Trash2 className="w-3.5 h-3.5" />
                                </Button>
                                </div>
                              </div>
                            )}
                            {isHistoryOpen && (
                              <div className="border-t border-border/60 px-4 py-3 bg-muted/30">
                                <p className="text-xs font-medium text-muted-foreground mb-2">Recent matches</p>
                                {historyLoading ? (
                                  <p className="text-xs text-muted-foreground">Loading…</p>
                                ) : alertHistory.length === 0 ? (
                                  <p className="text-xs text-muted-foreground">No matches yet.</p>
                                ) : (
                                  <div className="space-y-1.5 max-h-48 overflow-y-auto">
                                    {alertHistory.map((n: any) => (
                                      <button
                                        key={n.id}
                                        className={cn(
                                          "w-full text-left rounded-lg px-2.5 py-1.5 text-xs transition-colors",
                                          n.read ? "text-muted-foreground" : "text-foreground font-medium bg-primary/5",
                                        )}
                                        onClick={() => {
                                          if (!n.read) markNotificationRead.mutate(n.id);
                                        }}
                                      >
                                        <span className="block truncate">{n.body}</span>
                                        <span className="text-[10px] text-muted-foreground">
                                          {new Date(n.createdAt).toLocaleString()}
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
                Delete {pendingDelete?.type === "feed"
                  ? "feed"
                  : pendingDelete?.type === "category"
                    ? "category"
                    : pendingDelete?.type === "label"
                      ? "label"
                      : pendingDelete?.type === "auto-read-rule"
                        ? "rule"
                        : pendingDelete?.type === "keyword-alert"
                          ? "alert"
                        : "saved search"}?
              </AlertDialogTitle>
              <AlertDialogDescription>
                “{pendingDelete?.name}” will be removed. This cannot be undone.
              </AlertDialogDescription>
            </AlertDialogHeader>
            <AlertDialogFooter>
              <AlertDialogCancel className="rounded-2xl">Cancel</AlertDialogCancel>
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
                Delete
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
