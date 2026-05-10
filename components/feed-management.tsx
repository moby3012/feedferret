"use client";

import { useState } from "react";
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
  useCreateLabel,
  useDeleteLabel,
  useSavedSearches,
  useDeleteSavedSearch,
  useFeedHealth,
  useApplyRetentionPolicies,
  useAutoReadRules,
  useCreateAutoReadRule,
  useUpdateAutoReadRule,
  useDeleteAutoReadRule,
  useApplyAutoReadRulesNow,
  usePreviewAutoReadRule,
  useExportUserData,
} from "@/hooks/use-rss-data";
import { Button } from "@/components/ui/button";
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
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
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

  const style = {
    transform: CSS.Translate.toString(transform),
    transition,
    zIndex: isDragging ? 50 : undefined,
    opacity: isDragging ? 0.5 : 1,
  };

  return (
    <div
      ref={setNodeRef}
      style={style}
      className="group rounded-3xl border border-border/60 bg-card p-4 shadow-sm transition-all hover:border-border"
    >
      <div className="flex items-center gap-3">
        <div
          {...attributes}
          {...listeners}
          className="cursor-grab active:cursor-grabbing"
        >
          <Folder className="w-5 h-5 text-primary" />
        </div>
        {editingCategoryId === cat.id ? (
          <div className="flex-1 flex gap-2">
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
            <div className="flex-1">
              <span className="block font-semibold tracking-[-0.01em]">{cat.name}</span>
              <span className="text-[10px] text-muted-foreground uppercase font-bold tracking-widest">
                Sync: {cat.updateFrequency || "Global Default"} min
              </span>
            </div>
            <div className="flex items-center gap-1">
              <Input
                type="number"
                placeholder="min"
                className="h-8 w-16 rounded-xl border-border/70 bg-background/70 text-xs"
                defaultValue={cat.updateFrequency || ""}
                onBlur={(e) => {
                  const val = parseInt(e.target.value);
                  if (val !== cat.updateFrequency) {
                    updateCategory.mutate({
                      categoryId: cat.id,
                      data: { updateFrequency: isNaN(val) ? null : val },
                    });
                  }
                }}
              />
              <Button
                size="icon"
                variant="ghost"
                className="h-9 w-9 opacity-0 group-hover:opacity-100 rounded-xl"
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
                className="h-9 w-9 text-muted-foreground hover:text-destructive opacity-0 group-hover:opacity-100 rounded-xl"
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
  );
}

export function FeedManagement({
  open,
  onOpenChange,
  initialTab,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  initialTab?: "feeds" | "categories" | "labels" | "saved-searches" | "health" | "rules";
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
  const applyRetention = useApplyRetentionPolicies();
  const { data: feedHealth = [] } = useFeedHealth();
  const { data: autoReadRules = [] } = useAutoReadRules();
  const createAutoReadRule = useCreateAutoReadRule();
  const updateAutoReadRule = useUpdateAutoReadRule();
  const deleteAutoReadRule = useDeleteAutoReadRule();
  const applyAutoReadRulesNow = useApplyAutoReadRulesNow();
  const previewAutoReadRule = usePreviewAutoReadRule();

  const [newCategoryName, setNewCategoryName] = useState("");
  const [newLabelName, setNewLabelName] = useState("");
  const [newLabelColor, setNewLabelColor] = useState("#3b82f6");
  const [lastImportReport, setLastImportReport] = useState<any | null>(null);
  const [editingCategoryId, setEditingCategoryId] = useState<string | null>(
    null,
  );
  const [editingCategoryName, setEditingCategoryName] = useState("");
  const [pendingDelete, setPendingDelete] = useState<null | {
    type: "feed" | "category" | "label" | "saved-search" | "auto-read-rule";
    id: string;
    name: string;
  }>(null);

  const [newRuleName, setNewRuleName] = useState("");
  const [newRuleQuery, setNewRuleQuery] = useState("");
  const [newRuleAction, setNewRuleAction] = useState("mark_read");
  const [rulePreview, setRulePreview] = useState<any[] | null>(null);
  const [showAddRule, setShowAddRule] = useState(false);
  const [editingFeed, setEditingFeed] = useState<any | null>(null);

  const { data: categories = [] } = useCategories();
  const { data: labels = [] } = useLabels();
  const { data: savedSearches = [] } = useSavedSearches();

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
    exportOpml.mutate(undefined, {
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
        toast.success("Feeds exported successfully");
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

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-[95vw] w-[95vw] max-h-[95vh] h-[95vh] flex flex-col overflow-hidden rounded-[2rem] border border-border/70 bg-background p-0 shadow-2xl sm:max-w-none">
        <DialogHeader className="border-b border-border/60 bg-card/95 p-6 pb-5 backdrop-blur-2xl sm:p-8 sm:pb-5">
          <DialogTitle className="text-3xl font-semibold tracking-[-0.04em]">
            Management
          </DialogTitle>
          <DialogDescription className="mt-1 text-sm text-muted-foreground sm:text-base">
            Organize your feeds, categories, and data.
          </DialogDescription>
        </DialogHeader>

        <Tabs
          defaultValue={initialTab ?? "feeds"}
          key={initialTab ?? "feeds"}
          className="flex-1 flex flex-col min-h-0"
        >
          <div className="px-6 py-4 sm:px-8">
            <TabsList className="bg-muted/45 p-1 rounded-2xl w-fit border border-border/60 shadow-inner shadow-black/[0.02]">
              <TabsTrigger
                value="feeds"
                className="rounded-xl px-6 py-2.5 data-[state=active]:bg-background data-[state=active]:shadow-sm"
              >
                Feeds
              </TabsTrigger>
              <TabsTrigger
                value="categories"
                className="rounded-xl px-6 py-2.5 data-[state=active]:bg-background data-[state=active]:shadow-sm"
              >
                Categories
              </TabsTrigger>
              <TabsTrigger
                value="opml"
                className="rounded-xl px-6 py-2.5 data-[state=active]:bg-background data-[state=active]:shadow-sm"
              >
                Import/Export
              </TabsTrigger>
              <TabsTrigger
                value="labels"
                className="rounded-xl px-6 py-2.5 data-[state=active]:bg-background data-[state=active]:shadow-sm"
              >
                Labels & Searches
              </TabsTrigger>
              <TabsTrigger
                value="health"
                className="rounded-xl px-6 py-2.5 data-[state=active]:bg-background data-[state=active]:shadow-sm"
              >
                Health
              </TabsTrigger>
              <TabsTrigger
                value="rules"
                className="rounded-xl px-6 py-2.5 data-[state=active]:bg-background data-[state=active]:shadow-sm"
              >
                Rules
              </TabsTrigger>
            </TabsList>
          </div>

          <div className="flex-1 min-h-0">
            <TabsContent
              value="feeds"
              className="h-full mt-0 focus-visible:outline-none"
            >
              <ScrollArea className="h-full px-6 sm:px-8">
                <div className="space-y-3 pb-8">
                  {feeds.map((feed: any) => (
                    <div
                      key={feed.id}
                      className="group flex items-center gap-4 rounded-3xl border border-border/60 bg-card p-4 shadow-sm transition-all hover:border-border"
                    >
                      <div className="flex h-10 w-10 items-center justify-center rounded-2xl bg-background text-2xl shadow-sm">
                        {feed.icon || "📰"}
                      </div>
                      <div className="flex-1 min-w-0">
                        <div className="truncate font-semibold tracking-[-0.01em] text-foreground">
                          {feed.name}
                        </div>
                        <div className="text-xs text-muted-foreground truncate">
                          {feed.url}
                        </div>
                        <div className="mt-1 flex flex-wrap gap-2 text-[10px] text-muted-foreground">
                          <span>
                            Last sync:{" "}
                            {feed.lastFetchedAt
                              ? new Date(feed.lastFetchedAt).toLocaleString()
                              : "never"}
                          </span>
                          {feed.lastStatus === "error" && (
                            <span
                              className="text-destructive"
                              title={feed.lastError || undefined}
                            >
                              Sync error
                            </span>
                          )}
                        </div>
                      </div>
                      <Select
                        value={feed.categoryId || "none"}
                        onValueChange={(val: string) =>
                          updateFeed.mutate({
                            feedId: feed.id,
                            data: { categoryId: val === "none" ? null : val },
                          })
                        }
                      >
                        <SelectTrigger className="h-9 w-36 rounded-2xl border-border/70 bg-background/70 shadow-sm focus:ring-1">
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
                      <Input
                        type="number"
                        placeholder="Keep days"
                        defaultValue={feed.retentionDays || ""}
                        className="h-9 w-24 rounded-2xl border-border/70 bg-background/70 text-xs"
                        title="Retention days for read, unstarred articles"
                        onBlur={(e) => {
                          const value = parseInt(e.target.value, 10);
                          updateFeed.mutate({
                            feedId: feed.id,
                            data: { retentionDays: Number.isNaN(value) ? null : value },
                          });
                        }}
                      />
                      <Button
                        variant="ghost"
                        size="icon"
                        className="h-9 w-9 shrink-0 rounded-xl text-muted-foreground opacity-0 transition-all hover:bg-accent group-hover:opacity-100"
                        title="Feed settings"
                        onClick={() => setEditingFeed(feed)}
                      >
                        <Settings2 className="w-4 h-4" />
                      </Button>
                      <Button
                        variant="ghost"
                        size="icon"
                        className="h-9 w-9 shrink-0 rounded-xl text-muted-foreground opacity-0 transition-all hover:bg-destructive/10 hover:text-destructive group-hover:opacity-100"
                        onClick={() =>
                          setPendingDelete({
                            type: "feed",
                            id: feed.id,
                            name: feed.name,
                          })
                        }
                      >
                        <Trash2 className="w-4 h-4" />
                      </Button>
                    </div>
                  ))}
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
                      {savedSearches.map((search: any) => (
                        <div
                          key={search.id}
                          className="rounded-2xl border border-border/60 bg-background/60 p-3"
                        >
                          <div className="flex items-center gap-3">
                            <span className="flex-1 truncate text-sm font-medium">{search.name}</span>
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
                        </div>
                      ))}
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
                <div className="mb-5 flex flex-wrap items-center justify-between gap-3 rounded-3xl border border-border/60 bg-card p-5 shadow-sm">
                  <div className="flex items-center gap-3">
                    <Activity className="h-5 w-5 text-primary" />
                    <div>
                      <h3 className="font-semibold tracking-[-0.02em]">Feed Health Dashboard</h3>
                      <p className="text-sm text-muted-foreground">Sync status, errors, article counts and retention.</p>
                    </div>
                  </div>
                  <Button
                    onClick={() => applyRetention.mutate()}
                    disabled={applyRetention.isPending}
                    className="rounded-2xl"
                  >
                    <ShieldCheck className="mr-2 h-4 w-4" />
                    Apply retention
                  </Button>
                </div>
                <ScrollArea className="min-h-0 flex-1">
                  <div className="space-y-3 pb-8 pr-3">
                    {feedHealth.map((feed: any) => (
                      <div key={feed.id} className="rounded-3xl border border-border/60 bg-card p-4 shadow-sm">
                        <div className="flex items-start gap-4">
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
                            <div className="mt-3 grid grid-cols-2 gap-2 text-xs text-muted-foreground sm:grid-cols-4">
                              <span>{feed.articleCount} articles</span>
                              <span>{feed.unreadCount} unread</span>
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
              <div className="space-y-6 px-6 py-4 sm:px-8">
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
                    <div className="rounded-2xl border border-border/60 bg-background/70 p-4 text-sm">
                      <p className="font-medium">Last import report</p>
                      <p className="mt-1 text-muted-foreground">
                        {lastImportReport.feedsAdded} feeds added · {lastImportReport.feedsUpdated} feeds updated · {lastImportReport.categoriesAdded} categories added · {lastImportReport.errors.length} errors
                      </p>
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

                <div className="group space-y-4 rounded-3xl border border-border/60 bg-card p-7 shadow-sm transition-all hover:border-border">
                  <div className="flex items-center gap-3 text-xl font-semibold tracking-[-0.02em]">
                    <Download className="w-6 h-6 text-muted-foreground" />
                    Export subscriptions
                  </div>
                  <p className="text-muted-foreground">
                    Download all your feed subscriptions and categories in
                    standard OPML format.
                  </p>
                  <Button
                    onClick={handleExport}
                    variant="outline"
                    className="h-12 rounded-2xl border-border/70 bg-background/70 px-8 shadow-sm transition-all hover:bg-background active:scale-95"
                  >
                    Generate Export
                  </Button>
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
            </TabsContent>

            <TabsContent
              value="rules"
              className="h-full mt-0 focus-visible:outline-none"
            >
              <ScrollArea className="h-full px-6 sm:px-8">
                <div className="space-y-6 py-4 pb-8">
                  <div className="flex items-center justify-between">
                    <div>
                      <h3 className="text-lg font-semibold tracking-tight">Auto-mark rules</h3>
                      <p className="text-sm text-muted-foreground mt-0.5">
                        Automatically mark, star, or label articles matching a search query on each sync.
                      </p>
                    </div>
                    <div className="flex gap-2">
                      <Button
                        size="sm"
                        variant="outline"
                        className="rounded-xl gap-1.5"
                        onClick={() => applyAutoReadRulesNow.mutate()}
                        disabled={applyAutoReadRulesNow.isPending}
                      >
                        <Play className="w-3.5 h-3.5" />
                        Run now
                      </Button>
                      <Button
                        size="sm"
                        className="rounded-xl gap-1.5"
                        onClick={() => setShowAddRule(true)}
                      >
                        <Plus className="w-3.5 h-3.5" />
                        Add rule
                      </Button>
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
                        <div className="flex gap-2">
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

                      <div className="flex gap-2 justify-end">
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
                          className="flex items-center gap-3 rounded-2xl border border-border/60 bg-card px-4 py-3"
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
                            {rule.action === "mark_read"
                              ? "mark read"
                              : rule.action === "star"
                                ? "star"
                                : `label`}
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
          </div>
        </Tabs>
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
      </DialogContent>
    </Dialog>
  );
}
