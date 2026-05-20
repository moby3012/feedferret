"use client";

import { useEffect, useRef, useState } from "react";
import { useTranslations } from "next-intl";
import { Download, Home, Share, Smartphone, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";

const PWA_PROMPT_DISMISSED_KEY = "feedferret:pwa-install-prompt-dismissed";
export const SHOW_PWA_INSTALL_PROMPT_EVENT = "feedferret:show-pwa-install-prompt";

type BeforeInstallPromptEvent = Event & {
  prompt: () => Promise<void>;
  userChoice: Promise<{ outcome: "accepted" | "dismissed"; platform: string }>;
};

function isStandaloneDisplay() {
  return (
    window.matchMedia("(display-mode: standalone)").matches ||
    window.matchMedia("(display-mode: fullscreen)").matches ||
    (navigator as Navigator & { standalone?: boolean }).standalone === true
  );
}

function isMobileDevice() {
  return (
    window.matchMedia("(max-width: 1023px)").matches &&
    (window.matchMedia("(pointer: coarse)").matches || navigator.maxTouchPoints > 0)
  );
}

function dismissAutoPrompt() {
  try {
    window.localStorage.setItem(PWA_PROMPT_DISMISSED_KEY, "1");
  } catch {
    // Ignore storage failures; the app should continue to work.
  }
}

export function PwaInstallPrompt() {
  const t = useTranslations("pwa");
  const [open, setOpen] = useState(false);
  const [manualOpen, setManualOpen] = useState(false);
  const deferredPrompt = useRef<BeforeInstallPromptEvent | null>(null);

  useEffect(() => {
    const onBeforeInstallPrompt = (event: Event) => {
      event.preventDefault();
      deferredPrompt.current = event as BeforeInstallPromptEvent;
    };

    window.addEventListener("beforeinstallprompt", onBeforeInstallPrompt);
    return () => window.removeEventListener("beforeinstallprompt", onBeforeInstallPrompt);
  }, []);

  useEffect(() => {
    const onManualShow = () => {
      setManualOpen(true);
      setOpen(true);
    };

    window.addEventListener(SHOW_PWA_INSTALL_PROMPT_EVENT, onManualShow);
    return () => window.removeEventListener(SHOW_PWA_INSTALL_PROMPT_EVENT, onManualShow);
  }, []);

  useEffect(() => {
    if (isStandaloneDisplay() || !isMobileDevice()) return;

    try {
      if (window.localStorage.getItem(PWA_PROMPT_DISMISSED_KEY) === "1") return;
    } catch {
      return;
    }

    const timer = window.setTimeout(() => {
      setManualOpen(false);
      setOpen(true);
    }, 1200);

    return () => window.clearTimeout(timer);
  }, []);

  const closeAndRemember = () => {
    dismissAutoPrompt();
    setOpen(false);
  };

  const installOrClose = async () => {
    dismissAutoPrompt();

    const prompt = deferredPrompt.current;
    if (prompt) {
      await prompt.prompt();
      await prompt.userChoice.catch(() => null);
      deferredPrompt.current = null;
    }

    setOpen(false);
  };

  return (
    <Dialog
      open={open}
      onOpenChange={(nextOpen) => {
        if (!nextOpen) closeAndRemember();
        else setOpen(true);
      }}
    >
      <DialogContent className="max-w-[calc(100%-2rem)] rounded-[2rem] border-border/70 bg-background/95 p-0 shadow-2xl backdrop-blur-2xl sm:max-w-md" showCloseButton={false}>
        <div className="relative overflow-hidden rounded-[2rem] p-6">
          <button
            type="button"
            onClick={closeAndRemember}
            className="absolute right-4 top-4 inline-flex h-9 w-9 items-center justify-center rounded-full bg-muted/70 text-muted-foreground transition-colors hover:text-foreground"
            aria-label="Close"
          >
            <X className="h-4 w-4" />
          </button>

          <div className="mb-5 flex h-14 w-14 items-center justify-center rounded-3xl bg-accent/10 text-accent">
            <Smartphone className="h-7 w-7" />
          </div>

          <DialogHeader className="pr-8 text-left">
            <DialogTitle className="text-2xl tracking-[-0.04em]">
              {t("title")}
            </DialogTitle>
            <DialogDescription className="text-sm leading-6">
              {t("description")}
            </DialogDescription>
          </DialogHeader>

          <div className="mt-5 grid gap-3 text-sm text-muted-foreground">
            <div className="flex gap-3 rounded-2xl bg-muted/45 p-3">
              <Share className="mt-0.5 h-4 w-4 shrink-0 text-accent" />
              <p>{t("iphoneInstructions")}</p>
            </div>
            <div className="flex gap-3 rounded-2xl bg-muted/45 p-3">
              <Home className="mt-0.5 h-4 w-4 shrink-0 text-accent" />
              <p>{t("androidInstructions")}</p>
            </div>
          </div>

          <DialogFooter className="mt-6 gap-2 sm:flex-col-reverse sm:justify-stretch">
            <Button
              type="button"
              variant="ghost"
              onClick={closeAndRemember}
              className="h-12 rounded-2xl"
            >
              {t("notNow")}
            </Button>
            <Button
              type="button"
              onClick={installOrClose}
              className="h-12 rounded-2xl"
            >
              <Download className="mr-2 h-4 w-4" />
              {deferredPrompt.current ? t("install") : manualOpen ? t("done") : t("gotIt")}
            </Button>
          </DialogFooter>
        </div>
      </DialogContent>
    </Dialog>
  );
}
