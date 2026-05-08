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
} from "lucide-react";
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
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
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

  const [newCategoryName, setNewCategoryName] = useState("");
  const [editingCategoryId, setEditingCategoryId] = useState<string | null>(
    null,
  );
  const [editingCategoryName, setEditingCategoryName] = useState("");
  const [pendingDelete, setPendingDelete] = useState<null | {
    type: "feed" | "category";
    id: string;
    name: string;
  }>(null);

  const { data: categories = [] } = useCategories();

  const handleImport = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;

    const reader = new FileReader();
    reader.onload = async (event) => {
      const xml = event.target?.result as string;
      importOpml.mutate(xml, {
        onSuccess: () => toast.success("Feeds imported successfully"),
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

        <Tabs defaultValue="feeds" className="flex-1 flex flex-col min-h-0">
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
              </div>
            </TabsContent>
          </div>
        </Tabs>
        <AlertDialog
          open={!!pendingDelete}
          onOpenChange={(nextOpen) => {
            if (!nextOpen) setPendingDelete(null);
          }}
        >
          <AlertDialogContent className="rounded-3xl border-border/70 bg-background">
            <AlertDialogHeader>
              <AlertDialogTitle>
                Delete {pendingDelete?.type === "feed" ? "feed" : "category"}?
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
                  } else {
                    deleteCategory.mutate(pendingDelete.id);
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
