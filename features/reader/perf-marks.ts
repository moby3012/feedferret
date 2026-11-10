// User Timing marks for "tap → reader title painted" (spec §6 PR 8 budget
// ≤100 ms). `ff:article-open` is set when an article is opened from the UI
// (row tap, j/k); the reader sets `ff:reader-title` once the headline of that
// article has been committed and a frame has gone by, and records the measure
// `ff:tap-to-title` between the two. Visible in DevTools' Performance panel
// and read by the e2e timing test.

export const MARK_OPEN = "ff:article-open";
export const MARK_TITLE = "ff:reader-title";
export const MEASURE_TAP_TO_TITLE = "ff:tap-to-title";

let pendingId: string | null = null;

export function markArticleOpen(id: string) {
  if (typeof performance === "undefined" || typeof performance.mark !== "function") return;
  pendingId = id;
  performance.clearMarks(MARK_OPEN);
  performance.mark(MARK_OPEN, { detail: { id } });
}

/** Call from a layout effect after the headline of `id` is in the DOM. */
export function markTitlePainted(id: string) {
  if (pendingId !== id || typeof requestAnimationFrame !== "function") return;
  pendingId = null;
  // rAF runs right before the frame that shows the committed headline; the
  // task queued from it runs once that frame has been produced.
  requestAnimationFrame(() =>
    setTimeout(() => {
      try {
        performance.clearMarks(MARK_TITLE);
        performance.mark(MARK_TITLE, { detail: { id } });
        performance.clearMeasures(MEASURE_TAP_TO_TITLE);
        performance.measure(MEASURE_TAP_TO_TITLE, { start: MARK_OPEN, end: MARK_TITLE, detail: { id } });
      } catch {
        /* the open mark was cleared meanwhile */
      }
    }, 0),
  );
}
