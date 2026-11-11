"use client";

// N1 PR D: "Newsletter abbestellen" and "Adresse sperren" — shared by the
// reader "…" menu, the desktop sidebar and the compact Feeds screen.
//
// Nothing is ever opened or requested without a click: the one-click
// unsubscribe is a server action (RFC 8058 POST via safeFetch, URL re-read
// from the user's own row); a sender page or mailto opens from a plain link
// the user clicks (rel="noopener noreferrer").

import { useCallback, useState } from "react";
import { useTranslations } from "next-intl";
import { toast } from "sonner";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { ExternalLink, Loader2, Mail } from "lucide-react";
import {
  AlertDialog,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Button, buttonVariants } from "@/components/ui/button";
import { getNewsletterFeedActions, setMyNewsletterAddressActive, unsubscribeNewsletter } from "@/app/actions/newsletter";
import { useDeleteFeed } from "@/hooks/use-rss-data";
import type { NewsletterArticleMeta } from "@/features/articles/types";
import { cn } from "@/lib/utils";

export type NewsletterActionTarget = { articleId: string } | { feedId: string };

/** What the dialogs need: the newsletter view plus the feed it lives in. */
export type NewsletterActionInfo = Pick<NewsletterArticleMeta, "unsubscribe" | "blockAddress"> & { feedId: string; feedName: string };

type DialogState =
  | { kind: "unsubscribe"; step: "confirm" | "done"; target: NewsletterActionTarget; info: NewsletterActionInfo }
  | { kind: "block"; target: NewsletterActionTarget; info: NewsletterActionInfo };

/** The feed menu's view of a newsletter feed; fetched only while its menu is open. */
export function useNewsletterFeedActions(feedId: string, enabled: boolean) {
  return useQuery({
    queryKey: ["newsletter-feed-actions", feedId],
    queryFn: () => getNewsletterFeedActions({ feedId }),
    enabled,
    staleTime: 60_000,
  });
}

/**
 * Dialog host. `open` starts a flow; render `element` somewhere that stays
 * mounted after the menu that triggered it closes.
 */
export function useNewsletterDialogs() {
  const [state, setState] = useState<DialogState | null>(null);
  const openUnsubscribe = useCallback((target: NewsletterActionTarget, info: NewsletterActionInfo) => setState({ kind: "unsubscribe", step: "confirm", target, info }), []);
  const openBlock = useCallback((target: NewsletterActionTarget, info: NewsletterActionInfo) => setState({ kind: "block", target, info }), []);
  const element = <NewsletterDialogs state={state} onChange={setState} />;
  return { openUnsubscribe, openBlock, element };
}

function NewsletterDialogs({ state, onChange }: { state: DialogState | null; onChange: (next: DialogState | null) => void }) {
  const t = useTranslations("newsletterReader");
  const tCommon = useTranslations("common");
  const deleteFeed = useDeleteFeed();
  const queryClient = useQueryClient();
  const [pending, setPending] = useState(false);
  const close = () => {
    if (!pending) onChange(null);
  };

  const unsubscribe = state?.kind === "unsubscribe" ? state : null;
  const block = state?.kind === "block" ? state : null;
  const method = unsubscribe?.info.unsubscribe?.method ?? null;

  const runOneClick = async () => {
    if (!unsubscribe) return;
    setPending(true);
    try {
      const result = await unsubscribeNewsletter(unsubscribe.target);
      if (result.ok) {
        onChange({ ...unsubscribe, step: "done" });
      } else {
        toast.error(result.error === "rate-limited" ? t("unsubscribeRateLimited") : t("unsubscribeFailed"));
      }
    } catch {
      toast.error(t("unsubscribeFailed"));
    } finally {
      setPending(false);
    }
  };

  const runBlock = async () => {
    if (!block?.info.blockAddress) return;
    setPending(true);
    try {
      const result = await setMyNewsletterAddressActive({ id: block.info.blockAddress.id, active: false });
      if (result.ok) {
        // The feed menus must stop offering it (the reader's detail drops it on its next load).
        void queryClient.invalidateQueries({ queryKey: ["newsletter-feed-actions"] });
        toast.success(t("blockDone"));
        onChange(null);
      } else {
        toast.error(result.error === "last-active" ? t("blockLastActive") : t("blockFailed"));
      }
    } catch {
      toast.error(t("blockFailed"));
    } finally {
      setPending(false);
    }
  };

  const removeFeed = () => {
    if (!unsubscribe) return;
    deleteFeed.mutate(unsubscribe.info.feedId, {
      onSuccess: () => toast.success(t("feedRemoved")),
      onError: () => toast.error(t("feedRemoveFailed")),
    });
    onChange(null);
  };

  // A link/mailto opened by the user's own click: move on to "Feed auch entfernen?".
  const afterManual = () => {
    if (unsubscribe) window.setTimeout(() => onChange({ ...unsubscribe, step: "done" }), 0);
  };

  return (
    <>
      <AlertDialog open={unsubscribe !== null} onOpenChange={(o) => !o && close()}>
        <AlertDialogContent data-testid="newsletter-unsubscribe-dialog">
          {unsubscribe?.step === "done" ? (
            <>
              <AlertDialogHeader>
                <AlertDialogTitle>{method === "one-click" ? t("unsubscribedTitle") : t("unsubscribeOpenedTitle")}</AlertDialogTitle>
                <AlertDialogDescription>{t("removeFeedQuestion", { name: unsubscribe.info.feedName })}</AlertDialogDescription>
              </AlertDialogHeader>
              <AlertDialogFooter>
                <AlertDialogCancel>{t("keepFeed")}</AlertDialogCancel>
                <Button type="button" variant="destructive" onClick={removeFeed} data-testid="newsletter-remove-feed">
                  {t("removeFeed")}
                </Button>
              </AlertDialogFooter>
            </>
          ) : (
            <>
              <AlertDialogHeader>
                <AlertDialogTitle>{t("unsubscribeTitle")}</AlertDialogTitle>
                <AlertDialogDescription>
                  {method === "one-click"
                    ? t("unsubscribeOneClick", { name: unsubscribe?.info.feedName ?? "" })
                    : method === "link"
                      ? t("unsubscribeLink")
                      : method === "mailto"
                        ? t("unsubscribeMailto")
                        : t("unsubscribeUnknown")}
                </AlertDialogDescription>
              </AlertDialogHeader>
              <AlertDialogFooter>
                <AlertDialogCancel disabled={pending}>{tCommon("cancel")}</AlertDialogCancel>
                {method === "one-click" && (
                  <Button type="button" variant="destructive" disabled={pending} onClick={() => void runOneClick()} data-testid="newsletter-unsubscribe-confirm">
                    {pending && <Loader2 className="size-4 animate-spin" aria-hidden />}
                    {t("unsubscribe")}
                  </Button>
                )}
                {method === "link" && unsubscribe?.info.unsubscribe?.url && (
                  <a
                    href={unsubscribe.info.unsubscribe.url}
                    target="_blank"
                    rel="noopener noreferrer"
                    className={cn(buttonVariants({ variant: "default" }))}
                    onClick={afterManual}
                    data-testid="newsletter-unsubscribe-link"
                  >
                    {t("openUnsubscribePage")}
                    <ExternalLink className="size-4" aria-hidden />
                    <span className="sr-only"> {t("newTab")}</span>
                  </a>
                )}
                {method === "mailto" && unsubscribe?.info.unsubscribe?.mailto && (
                  <a
                    href={unsubscribe.info.unsubscribe.mailto}
                    className={cn(buttonVariants({ variant: "default" }))}
                    onClick={afterManual}
                    data-testid="newsletter-unsubscribe-mailto"
                  >
                    <Mail className="size-4" aria-hidden />
                    {t("writeUnsubscribeMail")}
                  </a>
                )}
              </AlertDialogFooter>
            </>
          )}
        </AlertDialogContent>
      </AlertDialog>

      <AlertDialog open={block !== null} onOpenChange={(o) => !o && close()}>
        <AlertDialogContent data-testid="newsletter-block-dialog">
          <AlertDialogHeader>
            <AlertDialogTitle>{t("blockTitle")}</AlertDialogTitle>
            <AlertDialogDescription>{t("blockDescription", { address: block?.info.blockAddress?.address ?? "" })}</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={pending}>{tCommon("cancel")}</AlertDialogCancel>
            <Button type="button" variant="destructive" disabled={pending} onClick={() => void runBlock()} data-testid="newsletter-block-confirm">
              {pending && <Loader2 className="size-4 animate-spin" aria-hidden />}
              {t("block")}
            </Button>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}
