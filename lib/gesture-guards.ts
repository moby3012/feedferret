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
