"use client";

import { useState } from "react";
import { useImportOpml, useExportOpml } from "@/hooks/use-rss-data";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Download, Upload, Loader2 } from "lucide-react";

export function OpmlManagement({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const [file, setFile] = useState<File | null>(null);
  const importOpml = useImportOpml();
  const exportOpml = useExportOpml();

  const handleImport = async () => {
    if (!file) return;
    const text = await file.text();
    importOpml.mutate(text, {
      onSuccess: () => {
        onOpenChange(false);
        setFile(null);
      },
    });
  };

  const handleExport = async () => {
    exportOpml.mutate(undefined, {
      onSuccess: (xml) => {
        const blob = new Blob([xml], { type: "text/xml" });
        const url = URL.createObjectURL(blob);
        const a = document.createElement("a");
        a.href = url;
        a.download = "feedfox-subscriptions.opml";
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        URL.revokeObjectURL(url);
      },
    });
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Management & OPML</DialogTitle>
          <DialogDescription>
            Import or export your RSS feed subscriptions.
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-6 py-4">
          <div className="space-y-2">
            <Label>Export Subscriptions</Label>
            <p className="text-sm text-muted-foreground mb-2">
              Download your current feed list as an industry-standard OPML file.
            </p>
            <Button
              variant="outline"
              className="w-full gap-2"
              onClick={handleExport}
              disabled={exportOpml.isPending}
            >
              {exportOpml.isPending ? (
                <Loader2 className="w-4 h-4 animate-spin" />
              ) : (
                <Download className="w-4 h-4" />
              )}
              Export OPML
            </Button>
          </div>

          <div className="border-t pt-6 space-y-2">
            <Label>Import Subscriptions</Label>
            <p className="text-sm text-muted-foreground mb-4">
              Select an OPML file to import your feeds and categories.
            </p>
            <div className="flex gap-2">
              <Input
                type="file"
                accept=".opml,.xml"
                className="flex-1"
                onChange={(e) => setFile(e.target.files?.[0] || null)}
              />
              <Button
                onClick={handleImport}
                disabled={!file || importOpml.isPending}
              >
                {importOpml.isPending ? (
                  <Loader2 className="w-4 h-4 animate-spin" />
                ) : (
                  <Upload className="w-4 h-4" />
                )}
                Import
              </Button>
            </div>
          </div>
        </div>
        <DialogFooter>
          <Button variant="secondary" onClick={() => onOpenChange(false)}>
            Close
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
