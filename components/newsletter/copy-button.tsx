"use client";

import { useState } from "react";
import { useTranslations } from "next-intl";
import { toast } from "sonner";
import { Copy } from "lucide-react";
import { Button } from "@/components/ui/button";

export function CopyButton({ value, testId, label }: { value: string; testId?: string; label?: string }) {
  const t = useTranslations("newsletterInbound");
  const [copied, setCopied] = useState(false);
  return (
    <Button
      variant="outline"
      size="sm"
      data-testid={testId}
      aria-label={label}
      onClick={async () => {
        try {
          await navigator.clipboard.writeText(value);
          setCopied(true);
          setTimeout(() => setCopied(false), 2000);
        } catch {
          toast.error(t("errors.unknown"));
        }
      }}
    >
      <Copy className="size-4" aria-hidden />
      {copied ? t("copied") : t("copy")}
    </Button>
  );
}
