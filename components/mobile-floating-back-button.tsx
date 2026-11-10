"use client";

import { useRouter } from "next/navigation";
import { ArrowLeft } from "lucide-react";
import { Button } from "@/components/ui/button";

export function MobileFloatingBackButton({
  fallbackHref = "/",
  label = "Back",
}: {
  fallbackHref?: string;
  label?: string;
}) {
  const router = useRouter();

  const handleBack = () => {
    if (typeof window !== "undefined" && window.history.length > 1) {
      router.back();
      return;
    }
    router.push(fallbackHref);
  };

  return (
    <div className="pointer-events-none fixed inset-x-0 bottom-0 z-(--z-overlay) pl-[max(1rem,var(--safe-l))] pr-[max(1rem,var(--safe-r))] pb-[max(1rem,var(--safe-b))] lg:hidden">
      <div className="mx-auto flex max-w-5xl justify-end">
        <Button
          type="button"
          variant="secondary"
          onClick={handleBack}
          className="pointer-events-auto h-12 rounded-full border border-border/70 bg-background/95 px-5 shadow-overlay backdrop-blur-bar"
          aria-label={label}
        >
          <ArrowLeft className="me-2 h-4 w-4 rtl:rotate-180" />
          {label}
        </Button>
      </div>
    </div>
  );
}
