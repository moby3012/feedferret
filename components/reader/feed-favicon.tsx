"use client";

import { useState } from "react";

/** Feed icon for the reader chrome: the feed's icon URL, else the site favicon, else the emoji/initial. */
export function FeedFavicon({ feedIcon, feedName, articleLink, size }: { feedIcon: string; feedName: string; articleLink: string; size: number }) {
  const [failed, setFailed] = useState(false);
  const isUrl = feedIcon?.startsWith("http") || feedIcon?.startsWith("/");
  let src: string | null = null;
  if (isUrl) src = feedIcon;
  else {
    try {
      src = `https://www.google.com/s2/favicons?domain=${new URL(articleLink).hostname}&sz=${size * 2}`;
    } catch {
      src = null;
    }
  }
  if (src && !failed) {
    // eslint-disable-next-line @next/next/no-img-element
    return <img src={src} alt="" width={size} height={size} referrerPolicy="no-referrer" className="rounded-chip object-contain" style={{ width: size, height: size }} onError={() => setFailed(true)} />;
  }
  return (
    <span aria-hidden="true" style={{ fontSize: size * 0.8, lineHeight: 1 }} title={feedName}>
      {feedIcon || "📰"}
    </span>
  );
}
