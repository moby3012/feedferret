/**
 * Shared guard for hand-rolled touch gestures: a touch that starts inside
 * content the user is meant to pan (code blocks, tables, any horizontally
 * scrollable box) must never be interpreted as an app-level swipe.
 */
const PAN_CONTENT_SELECTOR = "pre, code, table, [data-no-swipe]";

export function startsInPannableContent(target: EventTarget | null, boundary?: Element | null): boolean {
  if (!(target instanceof Element)) return false;
  if (target.closest(PAN_CONTENT_SELECTOR)) return true;

  // Any ancestor (up to the gesture surface) that scrolls horizontally and
  // actually has overflow — e.g. wide embeds or figures with overflow-x:auto.
  let el: Element | null = target;
  while (el && el !== boundary) {
    if (el instanceof HTMLElement && el.scrollWidth > el.clientWidth + 1) {
      const overflowX = window.getComputedStyle(el).overflowX;
      if (overflowX === "auto" || overflowX === "scroll") return true;
    }
    el = el.parentElement;
  }
  return false;
}

/**
 * Width of the screen-edge band the OS owns for its own back gesture (iOS
 * Safari / standalone edge-swipe, Android back gesture). App swipes must not
 * start there, or one gesture would go back twice.
 */
export const SYSTEM_EDGE_PX = 24;

/** True when a touch starts within the OS back-gesture band of either screen edge. */
export function startsAtSystemEdge(clientX: number, viewportWidth: number, edge = SYSTEM_EDGE_PX): boolean {
  return clientX < edge || clientX > viewportWidth - edge;
}
