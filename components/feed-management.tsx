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
  DialogTrigger,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { ScrollArea } from "@/components/ui/scroll-area";
import {
  Settings,
  Plus,
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
  closestCenter,
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
  deleteCategory,
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
      className="p-4 rounded-2xl bg-muted/20 border border-transparent hover:border-border transition-all group"
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
              className="h-9 rounded-xl bg-background border-none"
            />
            <Button
              size="icon"
              variant="ghost"
              className="h-9 w-9 text-green-500 hover:bg-green-500/10"
              onClick={() => {
                updateCategory.mutate({
                  categoryId: cat.id,
                  name: editingCategoryName,
                });
                setEditingCategoryId(null);
              }}
            >
              <Check className="w-4 h-4" />
            </Button>
            <Button
              size="icon"
              variant="ghost"
              className="h-9 w-9 text-muted-foreground"
              onClick={() => setEditingCategoryId(null)}
            >
              <X className="w-4 h-4" />
            </Button>
          </div>
        ) : (
          <>
            <div className="flex-1">
              <span className="font-bold block">{cat.name}</span>
              <span className="text-[10px] text-muted-foreground uppercase font-bold tracking-widest">
                Sync: {cat.updateFrequency || "Global Default"} min
              </span>
            </div>
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
              onClick={() => {
                if (confirm(`Delete category ${cat.name}?`))
                  deleteCategory.mutate(cat.id);
              }}
            >
              <Trash2 className="w-4 h-4" />
            </Button>
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
    if (!over || active.id === over.id) return;

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
      <DialogContent className="max-w-[95vw] w-[95vw] max-h-[95vh] h-[95vh] flex flex-col p-0 overflow-hidden bg-card border-none shadow-2xl rounded-3xl sm:max-w-none">
        <DialogHeader className="p-8 pb-4">
          <DialogTitle className="text-3xl font-bold tracking-tight">
            Management
          </DialogTitle>
          <DialogDescription className="text-muted-foreground text-lg">
            Organize your feeds, categories, and data.
          </DialogDescription>
        </DialogHeader>

        <Tabs defaultValue="feeds" className="flex-1 flex flex-col min-h-0">
          <div className="px-8 mb-4">
            <TabsList className="bg-muted/50 p-1 rounded-2xl w-fit">
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
              <ScrollArea className="h-[50vh] px-8">
                <div className="space-y-3 pb-8">
                  {feeds.map((feed: any) => (
                    <div
                      key={feed.id}
                      className="flex items-center gap-4 p-4 rounded-2xl bg-muted/30 border border-transparent hover:border-border hover:bg-muted/50 transition-all group"
                    >
                      <div className="text-2xl w-10 h-10 flex items-center justify-center bg-background rounded-xl shadow-sm">
                        {feed.icon || "📰"}
                      </div>
                      <div className="flex-1 min-w-0">
                        <div className="font-bold truncate text-foreground">
                          {feed.name}
                        </div>
                        <div className="text-xs text-muted-foreground truncate">
                          {feed.url}
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
                        <SelectTrigger className="w-32 h-9 rounded-lg bg-background border-none shadow-sm focus:ring-1">
                          <SelectValue placeholder="Category" />
                        </SelectTrigger>
                        <SelectContent className="rounded-xl border-none shadow-xl">
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
                        className="w-9 h-9 text-muted-foreground hover:text-destructive hover:bg-destructive/10 rounded-lg shrink-0 opacity-0 group-hover:opacity-100 transition-all"
                        onClick={() => {
                          if (confirm(`Delete ${feed.name}?`))
                            deleteFeed.mutate(feed.id);
                        }}
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
              <div className="px-8 flex flex-col h-full">
                <div className="flex gap-2 mb-6">
                  <Input
                    placeholder="New category name..."
                    value={newCategoryName}
                    onChange={(e) => setNewCategoryName(e.target.value)}
                    className="rounded-xl border-muted bg-muted/20 focus-visible:ring-primary h-11"
                  />
                  <Button
                    onClick={handleAddCategory}
                    className="bg-primary hover:bg-primary/90 rounded-xl px-6 transition-all active:scale-95 h-11"
                  >
                    <FolderPlus className="w-4 h-4 mr-2" />
                    Add
                  </Button>
                </div>
                <ScrollArea className="flex-1 h-[50vh] overflow-hidden min-h-0">
                  <DndContext
                    sensors={sensors}
                    collisionDetection={closestCenter}
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
                            deleteCategory={deleteCategory}
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
              <div className="px-8 py-4 space-y-6">
                <div className="p-8 rounded-3xl bg-primary/5 border border-primary/10 space-y-4">
                  <div className="font-bold text-xl flex items-center gap-3 text-primary">
                    <Upload className="w-6 h-6" />
                    Import subscriptions
                  </div>
                  <p className="text-muted-foreground">
                    Upload an OPML file to import all your feeds and categories
                    from another RSS reader.
                  </p>
                  <Label htmlFor="opml-upload" className="block">
                    <div className="inline-flex h-12 items-center justify-center rounded-xl bg-primary px-8 text-sm font-medium text-primary-foreground transition-all hover:bg-primary/90 active:scale-95 cursor-pointer shadow-lg shadow-primary/20">
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

                <div className="p-8 rounded-3xl bg-muted/20 border border-border space-y-4 group transition-all hover:bg-muted/30">
                  <div className="font-bold text-xl flex items-center gap-3">
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
                    className="h-12 rounded-xl px-8 border-muted hover:bg-background transition-all active:scale-95 shadow-sm"
                  >
                    Generate Export
                  </Button>
                </div>
              </div>
            </TabsContent>
          </div>
        </Tabs>
      </DialogContent>
    </Dialog>
  );
}
