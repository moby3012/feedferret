import { formatUnreadCount } from "@/lib/count-display";
import { cn } from "@/lib/utils";

/**
 * Unread number, spec §4.9: muted footnote text (never a filled or red
 * badge), tabular, "99+" above 99, nothing at 0. Assistive tech hears the
 * exact number (the visible cap is presentation only); `data-unread-count`
 * keeps it for tests and tooling.
 */
export function UnreadCount({ count, className }: { count: number; className?: string }) {
  if (!(count > 0)) return null;
  const capped = count > 99;
  return (
    <span className={cn("shrink-0 text-footnote tabular-nums text-muted-foreground", className)} data-unread-count={count}>
      {capped ? (
        <>
          <span aria-hidden data-unread-label>
            {formatUnreadCount(count)}
          </span>
          <span className="sr-only">{count}</span>
        </>
      ) : (
        count
      )}
    </span>
  );
}
