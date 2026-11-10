"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { OverlayId } from "./overlays";
import { getNavState, nav, useNav } from "./store";

/**
 * open / setOpen of a menu or popover whose trigger exists more than once
 * (reader "…" in the bar AND the pill, one "…" per feed row): the nav overlay
 * `id` is open AND this instance opened it. System Back closes it (on touch /
 * compact the overlay owns a history entry), never the screen beneath.
 *
 * Opened while another overlay is open (e.g. a feed "…" inside the sources
 * drawer on tablets) it stays local: overlays never nest, and swapping would
 * close the drawer it sits in.
 */
export function useOwnedOverlay(id: OverlayId): [boolean, (open: boolean) => void] {
  const navOpen = useNav((s) => s.overlay === id);
  const [owned, setOwned] = useState(false);
  const [local, setLocal] = useState(false);
  // Drop ownership when the overlay closes (Back, Escape, another overlay) —
  // only on the open → closed edge: right after `setOwned(true)` the store
  // has not caught up yet.
  const wasOpen = useRef(false);
  useEffect(() => {
    if (wasOpen.current && !navOpen) setOwned(false);
    wasOpen.current = navOpen;
  }, [navOpen]);

  const live = useRef({ owned, local });
  live.current = { owned, local };
  const setOpen = useCallback(
    (next: boolean) => {
      if (next) {
        const current = getNavState().overlay;
        if (current && current !== id) {
          setLocal(true);
          return;
        }
        setOwned(true);
        void nav.openOverlay(id);
        return;
      }
      if (live.current.local) setLocal(false);
      if (live.current.owned) void nav.closeOverlay(id);
    },
    [id],
  );
  return [local || (owned && navOpen), setOpen];
}
