"use client";

import { useTranslations } from "next-intl";
import { toast } from "sonner";
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
import { useDeleteCategory } from "@/hooks/use-rss-data";

/**
 * Short confirm for deleting an empty category from its "No feeds" line (desktop sidebar and
 * compact Feeds screen). Same `deleteCategory` action as the feed manager; the server still
 * checks ownership. The caller only offers it for categories that pass `isDeletableEmptyCategory`.
 */
export function DeleteEmptyCategoryDialog({
  category,
  onClose,
}: {
  category: { id: string; name: string } | null;
  onClose(): void;
}) {
  const t = useTranslations("sidebar");
  const tc = useTranslations("common");
  const deleteCategory = useDeleteCategory();
  return (
    <AlertDialog open={!!category} onOpenChange={(open) => !open && onClose()}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>{t("deleteCategoryTitle", { name: category?.name ?? "" })}</AlertDialogTitle>
          <AlertDialogDescription>{t("deleteCategoryDescription")}</AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel>{tc("cancel")}</AlertDialogCancel>
          <AlertDialogAction
            className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
            onClick={() => {
              if (!category) return;
              deleteCategory.mutate(category.id, {
                onSuccess: () => toast.success(t("categoryDeleted")),
                onError: () => toast.error(t("categoryDeleteFailed")),
              });
              onClose();
            }}
          >
            {t("deleteCategoryAction")}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
