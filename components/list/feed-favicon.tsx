"use client";

import { memo, useState } from "react";
import { Mail } from "lucide-react";

/**
 * Feed icon with a Google-favicon fallback and a letter tile as last resort.
 * Fixed box (`size`×`size`) in every state, so a failing icon never shifts the row.
 */
export const FeedFavicon = memo(function FeedFavicon({
  icon,
  name,
  size = 16,
  articleLink,
  newsletter = false,
}: {
  icon?: string | null;
  name?: string;
  size?: number;
  articleLink?: string;
  /** Newsletter feed: an envelope instead of a favicon lookup (no web origin to ask). */
  newsletter?: boolean;
}) {
  const [failed, setFailed] = useState(false);
  const isUrl = icon ? icon.startsWith("http") || icon.startsWith("/") || icon.startsWith("data:") : false;
  if (newsletter && !(isUrl && !failed)) return <NewsletterIcon size={size} />;
  let src: string | null = null;
  if (isUrl && icon) {
    src = icon;
  } else if (articleLink) {
    try {
      const domain = new URL(articleLink).hostname;
      src = `https://www.google.com/s2/favicons?domain=${domain}&sz=${Math.max(32, size * 2)}`;
    } catch {
      src = null;
    }
  }
  if (src && !failed) {
    return (
      // eslint-disable-next-line @next/next/no-img-element
      <img
        src={src}
        alt=""
        width={size}
        height={size}
        loading="lazy"
        decoding="async"
        draggable={false}
        // The Google favicon fallback is a third-party request per article
        // domain; no-referrer at least keeps our own page URL from being
        // sent along with it.
        referrerPolicy="no-referrer"
        className="shrink-0 rounded-chip object-contain"
        style={{ width: size, height: size }}
        onError={() => setFailed(true)}
      />
    );
  }
  return (
    <span
      aria-hidden="true"
      style={{ width: size, height: size, fontSize: Math.max(8, size * 0.55), lineHeight: `${size}px` }}
      className="inline-flex shrink-0 items-center justify-center rounded-chip bg-muted font-semibold uppercase text-muted-foreground"
    >
      {(name ?? "?").trim().charAt(0)}
    </span>
  );
});

/** Envelope tile for newsletter feeds; same fixed box as a favicon. */
export function NewsletterIcon({ size = 16 }: { size?: number }) {
  return (
    <span
      aria-hidden="true"
      data-newsletter-icon=""
      style={{ width: size, height: size }}
      className="inline-flex shrink-0 items-center justify-center rounded-chip bg-accent-subtle text-brand"
    >
      <Mail style={{ width: Math.round(size * 0.7), height: Math.round(size * 0.7) }} strokeWidth={2} />
    </span>
  );
}
